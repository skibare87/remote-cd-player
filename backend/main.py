from fastapi import FastAPI, HTTPException, Response, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import discid
import musicbrainzngs
import subprocess
import os
import asyncio
from pydantic import BaseModel
import logging
import time
import shutil
from typing import Dict, Optional, List
import sys
import signal
import psutil
import json
from datetime import datetime
import xml.etree.ElementTree as ET

# Configure logging with more detailed format
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Log startup information
logger.info(f"Python version: {sys.version}")
logger.info(f"Starting CD Player backend service")

# Global cleanup flag
cleanup_in_progress = False

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Type", "Content-Range", "Content-Length", "Accept-Ranges"]
)

musicbrainzngs.set_useragent("WebCDPlayer", "1.0")

# Cache for CD info
cd_info_cache = {
    "last_check": 0,
    "disc_id": None,
    "info": None
}

class TrackInfo(BaseModel):
    number: int
    title: str
    duration: int

class CDInfo(BaseModel):
    title: str
    artist: str
    tracks: list[TrackInfo]

class BufferStatus(BaseModel):
    track_number: int
    buffer_size: int
    complete: bool
    memory_usage: float
    buffering_time: float

class SystemStatus(BaseModel):
    total_memory: float
    used_memory: float
    cpu_percent: float
    active_buffers: List[BufferStatus]
    current_track: Optional[int]
    next_track: Optional[int]

class TrackBuffer:
    def __init__(self, track_number: int):
        self.track_number = track_number
        self.data = bytearray()
        self.complete = False
        self.generator = None
        self.start_time = time.time()
        self.size = 0
        self.error = None

    def get_status(self) -> BufferStatus:
        return BufferStatus(
            track_number=self.track_number,
            buffer_size=len(self.data),
            complete=self.complete,
            memory_usage=len(self.data) / (1024 * 1024),  # MB
            buffering_time=time.time() - self.start_time
        )

class TrackBufferManager:
    def __init__(self):
        self.buffers: Dict[int, TrackBuffer] = {}
        self.current_track = None
        self.next_track = None
        self._lock = asyncio.Lock()
        self.max_buffer_size = 1024 * 1024 * 10  # 10MB buffer limit per track
        self.max_total_buffers = 3  # Maximum number of tracks to buffer
        self.last_access = {}

    async def start_buffering(self, track_number: int, priority: bool = False):
        """Start buffering a track in memory"""
        async with self._lock:
            # Check if we need to clear old buffers
            await self._cleanup_old_buffers()

            if track_number in self.buffers:
                self.last_access[track_number] = time.time()
                return

            logger.debug(f"Starting buffer for track {track_number} (priority: {priority})")
            buffer = TrackBuffer(track_number)
            self.buffers[track_number] = buffer
            self.last_access[track_number] = time.time()

            try:
                buffer.generator = AudioChunkGenerator(track_number)
                await buffer.generator.start()
                if priority:
                    # For priority buffers, wait for some initial data
                    await self._buffer_initial_data(track_number)
                asyncio.create_task(self._buffer_track(track_number))
            except Exception as e:
                logger.error(f"Error starting buffer for track {track_number}: {e}")
                await self.clear_buffer(track_number)

    async def _buffer_initial_data(self, track_number: int, initial_size: int = 512 * 1024):
        """Buffer initial data for priority tracks"""
        buffer = self.buffers[track_number]
        try:
            async for chunk in buffer.generator.generate():
                buffer.data.extend(chunk)
                if len(buffer.data) >= initial_size:
                    break
        except Exception as e:
            logger.error(f"Error buffering initial data for track {track_number}: {e}")

    async def _buffer_track(self, track_number: int):
        """Buffer track data in memory"""
        try:
            buffer = self.buffers[track_number]
            async for chunk in buffer.generator.generate():
                if len(buffer.data) < self.max_buffer_size:
                    buffer.data.extend(chunk)
                    buffer.size = len(buffer.data)
                else:
                    break
            buffer.complete = True
            logger.debug(f"Track {track_number} buffering complete, size: {buffer.size} bytes")
        except Exception as e:
            logger.error(f"Error buffering track {track_number}: {e}")
            buffer.error = str(e)
            await self.clear_buffer(track_number)

    async def get_track_stream(self, track_number: int):
        """Get a stream of track data, either from buffer or direct"""
        self.last_access[track_number] = time.time()
        
        if track_number in self.buffers:
            buffer = self.buffers[track_number]
            if buffer.complete:
                logger.debug(f"Serving track {track_number} from buffer")
                yield bytes(buffer.data)
                return
            elif len(buffer.data) > 0:
                logger.debug(f"Serving track {track_number} from partial buffer")
                yield bytes(buffer.data)

        logger.debug(f"Serving track {track_number} directly")
        generator = AudioChunkGenerator(track_number)
        await generator.start()
        async for chunk in generator.generate():
            yield chunk

    async def prepare_next_track(self, current_track: int, total_tracks: int):
        """Prepare the next track if available"""
        next_track = current_track + 1 if current_track < total_tracks else None
        if next_track:
            logger.debug(f"Preloading next track: {next_track}")
            self.next_track = next_track
            await self.start_buffering(next_track)

    async def _cleanup_old_buffers(self):
        """Clean up old buffers based on access time and memory usage"""
        if len(self.buffers) >= self.max_total_buffers:
            # Sort buffers by last access time
            sorted_buffers = sorted(
                self.last_access.items(),
                key=lambda x: x[1]
            )
            # Remove oldest buffers until we're under the limit
            while len(self.buffers) >= self.max_total_buffers:
                oldest_track = sorted_buffers[0][0]
                await self.clear_buffer(oldest_track)
                sorted_buffers.pop(0)

    async def clear_buffer(self, track_number: int):
        """Clear a track's buffer"""
        async with self._lock:
            if track_number in self.buffers:
                buffer = self.buffers[track_number]
                if buffer.generator:
                    await buffer.generator.stop()
                del self.buffers[track_number]
                if track_number in self.last_access:
                    del self.last_access[track_number]
                logger.debug(f"Cleared buffer for track {track_number}")

    async def clear_all_buffers(self):
        """Clear all track buffers"""
        async with self._lock:
            for track_number in list(self.buffers.keys()):
                await self.clear_buffer(track_number)
            self.current_track = None
            self.next_track = None
            self.last_access.clear()

    def get_status(self) -> SystemStatus:
        """Get current buffer and system status"""
        process = psutil.Process()
        return SystemStatus(
            total_memory=psutil.virtual_memory().total / (1024 * 1024),
            used_memory=process.memory_info().rss / (1024 * 1024),
            cpu_percent=process.cpu_percent(),
            active_buffers=[buffer.get_status() for buffer in self.buffers.values()],
            current_track=self.current_track,
            next_track=self.next_track
        )
def create_generic_cd_info(disc):
    """Create generic CD info when MusicBrainz metadata is not available"""
    logger.debug(f"Creating generic CD info for disc ID: {disc.id}")
    tracks = []
    for i, track in enumerate(disc.tracks, 1):
        logger.debug(f"Adding track {i} with {track.sectors} sectors")
        tracks.append(TrackInfo(
            number=i,
            title=f"Track {i}",
            duration=int(track.sectors / 75)
        ))
    
    return CDInfo(
        title="Audio CD",
        artist="Unknown Artist",
        tracks=tracks
    )

class AudioChunkGenerator:
    def __init__(self, track_number: int):
        self.track_number = track_number
        self.process = None
        self.stopped = False
        self.bytes_read = 0
        self.initialized = False

    async def start(self):
        if self.initialized:
            return
        
        logger.debug(f"Starting generator for track {self.track_number}")
        try:
            self.process = await asyncio.create_subprocess_exec(
                'cdparanoia',
                '--force-cdrom-device=/dev/cdrom',
                '--verbose',
                '--output-wav',
                '--never-skip=40',  # More aggressive reading
                '--sample-offset=0',  # Prevent initial offset
                f'{self.track_number}:{self.track_number}',
                '-',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            async def log_stderr():
                while True:
                    line = await self.process.stderr.readline()
                    if not line:
                        break
                    logger.debug(f"cdparanoia: {line.decode().strip()}")
            
            asyncio.create_task(log_stderr())
            self.initialized = True
            logger.debug(f"Process started for track {self.track_number}")
        except Exception as e:
            logger.error(f"Error starting process: {e}")
            await self.stop()
            raise

    async def generate(self):
        try:
            CHUNK_SIZE = 16384  # Increased chunk size
            logger.debug(f"Starting audio streaming with chunk size: {CHUNK_SIZE}")
            
            while not self.stopped and self.process and self.process.stdout:
                chunk = await self.process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    logger.debug("No more data from cdparanoia")
                    break

                self.bytes_read += len(chunk)
                if self.bytes_read % (CHUNK_SIZE * 64) == 0:
                    logger.debug(f"Streaming progress: {self.bytes_read/1024:.2f}KB")
                yield chunk

        except Exception as e:
            logger.error(f"Error in generate: {e}")
            raise
        finally:
            logger.debug(f"Streaming complete. Total bytes read: {self.bytes_read}")
            await self.stop()

    async def stop(self):
        logger.debug(f"Stopping generator for track {self.track_number}")
        self.stopped = True
        
        if self.process:
            try:
                if not self.process.stdout.at_eof():
                    logger.debug("Terminating cdparanoia process")
                    self.process.terminate()
                await self.process.wait()
                logger.debug("cdparanoia process terminated")
            except Exception as e:
                logger.error(f"Error stopping cdparanoia: {e}")
            self.process = None

# Global instances
generator_lock = asyncio.Lock()
buffer_manager = TrackBufferManager()
active_generators = {}

async def read_cd_info():
    """Read CD info and cache it"""
    try:
        logger.debug("Checking CD drive...")
        if not os.path.exists("/dev/cdrom"):
            logger.error("CD device not found")
            raise HTTPException(status_code=404, detail="CD device not found")

        try:
            disc = discid.read("/dev/cdrom")
            logger.debug(f"Disc ID: {disc.id}")
            
            # Check cache
            if (cd_info_cache["disc_id"] == disc.id and 
                cd_info_cache["info"] is not None and 
                time.time() - cd_info_cache["last_check"] < 30):
                logger.debug("Returning cached CD info")
                return cd_info_cache["info"]
            
            try:
                result = musicbrainzngs.get_releases_by_discid(disc.id, includes=["artists", "recordings"])
                logger.debug("Retrieved MusicBrainz data")
                
                if result and 'disc' in result and 'release-list' in result['disc']:
                    release = result['disc']['release-list'][0]
                    
                    logger.debug(f"Release data: {release.keys()}")
                    
                    # Get artist credit
                    artist = "Unknown Artist"
                    if 'artist-credit' in release:
                        logger.debug(f"Artist credit: {release['artist-credit']}")
                        try:
                            artist_credit = release['artist-credit']
                            if isinstance(artist_credit, list) and len(artist_credit) > 0:
                                artist = artist_credit[0]['artist']['name']
                            elif isinstance(artist_credit, dict):
                                artist = artist_credit['name']
                        except (KeyError, IndexError) as e:
                            logger.debug(f"Error extracting artist name: {e}")
                    
                    logger.debug(f"Artist: {artist}")
                    
                    tracks = []
                    if 'medium-list' in release:
                        for medium in release['medium-list']:
                            if 'track-list' in medium:
                                logger.debug(f"Track list found: {len(medium['track-list'])} tracks")
                                for track in medium['track-list']:
                                    try:
                                        track_title = track.get('recording', {}).get('title', f"Track {track.get('position', '?')}")
                                        track_length = int(track.get('length', 0))
                                        track_number = int(track.get('position', 0))
                                        
                                        tracks.append(TrackInfo(
                                            number=track_number,
                                            title=track_title,
                                            duration=track_length // 1000  # Convert milliseconds to seconds
                                        ))
                                        logger.debug(f"Added track: {track_number}. {track_title} ({track_length}ms)")
                                    except Exception as e:
                                        logger.debug(f"Error processing track: {e}")
                    
                    if tracks:
                        logger.debug(f"Successfully created CD info from MusicBrainz with {len(tracks)} tracks")
                        info = CDInfo(
                            title=release.get('title', 'Unknown Album'),
                            artist=artist,
                            tracks=tracks
                        )
                        logger.debug(f"CD Info: Title: {info.title}, Artist: {info.artist}, Tracks: {len(info.tracks)}")
                    else:
                        logger.info("No valid track data from MusicBrainz, using generic")
                        info = create_generic_cd_info(disc)
                else:
                    logger.info("No release data from MusicBrainz, using generic")
                    info = create_generic_cd_info(disc)
                
            except Exception as e:
                logger.info(f"Error processing MusicBrainz data: {e}, using generic")
                info = create_generic_cd_info(disc)
            
            # Update cache
            cd_info_cache["disc_id"] = disc.id
            cd_info_cache["info"] = info
            cd_info_cache["last_check"] = time.time()
            
            return info
            
        except Exception as e:
            logger.error(f"Error reading disc: {e}")
            raise HTTPException(status_code=404, detail=f"Error reading CD: {str(e)}")
            
    except Exception as e:
        logger.error(f"Error reading CD: {e}")
        raise HTTPException(status_code=404, detail=str(e))

@app.get("/cd/info")
async def get_cd_info():
    logger.debug("CD info request received")
    return await read_cd_info()

@app.get("/cd/play/{track_number}")
async def play_track(track_number: int, background_tasks: BackgroundTasks):
    logger.info(f"Play track request received for track {track_number}")
    try:
        # Stop any existing playback first
        await stop_playback()
        
        cd_info = await read_cd_info()
        if track_number < 1 or track_number > len(cd_info.tracks):
            raise HTTPException(status_code=400, detail="Invalid track number")

        generator = AudioChunkGenerator(track_number)
        await generator.start()

        headers = {
            'Content-Type': 'audio/wav',
            'Cache-Control': 'no-cache',
            'Accept-Ranges': 'bytes',
            'Transfer-Encoding': 'chunked'
        }

        return StreamingResponse(
            generator.generate(),
            headers=headers,
            media_type="audio/wav"
        )

    except Exception as e:
        logger.error(f"Error starting playback: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/cd/stop")
async def stop_playback():
    logger.info("Stop playback request received")
    try:
        # Acquire lock to prevent race conditions
        async with generator_lock:
            # Stop all active generators
            for generator in list(active_generators.values()):
                try:
                    await generator.stop()
                except Exception as e:
                    logger.error(f"Error stopping generator: {e}")
            
            # Clear the generators
            active_generators.clear()

        # Clean up any orphaned processes
        try:
            cleanup_orphaned_processes()
        except Exception as e:
            logger.error(f"Error in cleanup: {e}")

        # Kill any remaining cdparanoia processes
        try:
            subprocess.run(['pkill', '-9', 'cdparanoia'], capture_output=True)
        except Exception as e:
            logger.error(f"Error killing processes: {e}")
        
        return {"status": "stopped"}
    except Exception as e:
        logger.error(f"Error stopping playback: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/status")
async def get_status():
    """Get current system and buffer status"""
    return buffer_manager.get_status()

@app.get("/health")
async def health_check():
    logger.debug("Health check request received")
    return {"status": "healthy"}

def cleanup_orphaned_processes():
    """Clean up any orphaned cdparanoia processes"""
    try:
        current_process = psutil.Process()
        children = current_process.children(recursive=True)
        
        for process in children:
            try:
                if 'cdparanoia' in process.name():
                    logger.debug(f"Cleaning up orphaned process: {process.pid}")
                    process.terminate()
                    process.wait(timeout=3)
            except Exception as e:
                logger.error(f"Error cleaning up process {process.pid}: {e}")
                try:
                    process.kill()
                except:
                    pass
    except Exception as e:
        logger.error(f"Error in cleanup_orphaned_processes: {e}")

async def graceful_shutdown(signal_num, frame):
    """Handle graceful shutdown"""
    global cleanup_in_progress
    
    if cleanup_in_progress:
        return
        
    cleanup_in_progress = True
    logger.info("Initiating graceful shutdown...")
    
    try:
        # Clean up any active generators
        for generator in list(active_generators.values()):
            try:
                await generator.stop()
            except:
                pass
        active_generators.clear()
        
        # Clean up any orphaned processes
        cleanup_orphaned_processes()
        
    except Exception as e:
        logger.error(f"Error during graceful shutdown: {e}")
    
    finally:
        cleanup_in_progress = False

# Add periodic cleanup task
async def periodic_cleanup():
    """Periodically check for and clean up orphaned processes"""
    while True:
        try:
            await asyncio.sleep(300)  # Run every 5 minutes
            if not cleanup_in_progress:
                cleanup_orphaned_processes()
        except Exception as e:
            logger.error(f"Error in periodic cleanup: {e}")

# Update the main block to include signal handlers and cleanup
if __name__ == "__main__":
    import uvicorn
    
    # Set up signal handlers
    signal.signal(signal.SIGTERM, graceful_shutdown)
    signal.signal(signal.SIGINT, graceful_shutdown)
    
    # Start periodic cleanup task
    asyncio.create_task(periodic_cleanup())
    
    logger.info("Starting CD Player backend service")
    uvicorn.run(app, host="0.0.0.0", port=3000)
