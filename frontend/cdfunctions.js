// Global variables
let cdInfo = null;
let currentTrack = null;
let isPlaying = false;
let pollingInterval = null;
let lastCheckTime = 0;
let isInitialized = false;
let cleanupInitialized = false;
let audioContext;
let audioSource;
let startTime;
let progressInterval;
let currentBuffer;

const CHECK_INTERVAL = 5000; // 5 seconds

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 5000, ...remainingOptions } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(resource, {
            ...remainingOptions,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// CD Information Management
async function loadCDInfo() {
    const now = Date.now();
    if (now - lastCheckTime < CHECK_INTERVAL) {
        return;
    }
    lastCheckTime = now;

    try {
        const response = await fetchWithTimeout('/api/cd/info', { timeout: 3000 });
        if (!response.ok) {
            throw new Error('Failed to load CD info');
        }
        const newCdInfo = await response.json();
        
        // Only update if CD info has changed
        if (!cdInfo || newCdInfo.tracks.length !== cdInfo.tracks.length) {
            cdInfo = newCdInfo;
            updateInterface();
        }
        
    } catch (error) {
        console.error('Error loading CD info:', error);
        document.getElementById('cd-info').textContent = 'No CD found';
        document.getElementById('playlist').innerHTML = 
            '<div class="status-message">No CD detected</div>';
        updateControls(false);
    }
}

function updateInterface() {
    const cdInfoElement = document.getElementById('cd-info');
    if (cdInfoElement) {
        cdInfoElement.textContent = `${cdInfo.artist} - ${cdInfo.title}`;
    }
    
    const playlist = document.getElementById('playlist');
    if (playlist) {
        playlist.innerHTML = '';
        
        cdInfo.tracks.forEach((track) => {
            const trackElement = document.createElement('div');
            trackElement.className = 'track-item';
            trackElement.innerHTML = `
                <span>${track.number}. ${track.title}</span>
                <span>${formatTime(track.duration)}</span>
            `;
            trackElement.addEventListener('click', () => playTrack(track.number));
            playlist.appendChild(trackElement);
        });
    }

    updateControls(true);
    updatePlaylistHighlight();
}

async function playTrack(trackNumber) {
    console.log(`Attempting to play track ${trackNumber}`);
    try {
        if (!cdInfo) {
            console.log("No CD info available, cannot play");
            return;
        }
        
        await stopTrack();
        
        currentTrack = trackNumber;
        
        const track = cdInfo.tracks.find(t => t.number === trackNumber);
        if (!track) {
            console.error(`Track ${trackNumber} not found in CD info`);
            return;
        }

        console.log(`Loading track: ${track.number}. ${track.title}`);
        const currentTrackElement = document.getElementById('current-track');
        currentTrackElement.textContent = `Loading: ${track.number}. ${track.title}`;
        currentTrackElement.classList.add('track-change');
        
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        const response = await fetch(`/api/cd/play/${trackNumber}`);
        const arrayBuffer = await response.arrayBuffer();
        
        try {
            currentBuffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (decodeError) {
            console.error('Error decoding audio data:', decodeError);
            throw new Error('Failed to decode audio data');
        }
        
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = currentBuffer;
        audioSource.connect(audioContext.destination);
        
        audioSource.addEventListener('ended', () => {
            if (currentTrack < cdInfo.tracks.length) {
                playTrack(currentTrack + 1);
            } else {
                console.log("End of CD reached");
                stopTrack();
            }
        });

        startTime = audioContext.currentTime;
        audioSource.start();
        isPlaying = true;
        document.getElementById('play-pause').textContent = '⏸';
        
        currentTrackElement.textContent = `${track.number}. ${track.title}`;
        currentTrackElement.classList.remove('track-change');
        
        updatePlaylistHighlight();
        updateControls(true);
        
        // Start progress updates
        updateProgress();
        progressInterval = setInterval(updateProgress, 1000);
        
        console.log(`Playback initiated for track ${trackNumber}`);
    } catch (error) {
        console.error('Error playing track:', error);
        document.getElementById('current-track').textContent = 
            'Error playing track. Please try again.';
        document.getElementById('playlist').classList.remove('loading');
        isPlaying = false;
    } finally {
        updateControls(true);
    }
}

function updateProgress() {
    if (!audioSource || !audioContext || !currentBuffer) return;
    
    const currentTime = audioContext.currentTime - startTime;
    const duration = currentBuffer.duration;
    const progressPercent = (currentTime / duration) * 100;
    
    document.getElementById('progress').style.width = `${progressPercent}%`;
    document.getElementById('current-time').textContent = formatTime(currentTime);
    document.getElementById('total-time').textContent = formatTime(duration);
}

function updatePlaylistHighlight() {
    document.querySelectorAll('.track-item').forEach((item, index) => {
        item.classList.toggle('playing', index + 1 === currentTrack);
    });
}

async function stopTrack() {
    try {
        stopPolling();
        
        if (audioSource) {
            audioSource.stop();
            audioSource.disconnect();
            audioSource = null;
        }
        
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        isPlaying = false;
        currentBuffer = null;
        
        document.getElementById('play-pause').textContent = '▶';
        document.getElementById('playlist').classList.remove('loading');
        document.getElementById('current-track').textContent = 'Playback stopped';
        document.getElementById('current-time').textContent = '0:00';
        document.getElementById('total-time').textContent = '0:00';
        document.getElementById('progress').style.width = '0%';
        
        const response = await fetchWithTimeout('/api/cd/stop', { 
            timeout: 3000,
            method: 'GET'
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        updatePlaylistHighlight();
        updateControls(true);
        
    } catch (error) {
        console.error('Error stopping playback:', error);
    } finally {
        setTimeout(startPolling, 1000);
    }
}

async function playPause() {
    if (!cdInfo) {
        console.log("No CD info available, cannot play/pause");
        return;
    }
    
    if (!currentTrack) {
        await playTrack(1);
    } else if (isPlaying) {
        audioContext.suspend();
        isPlaying = false;
        document.getElementById('play-pause').textContent = '▶';
    } else {
        audioContext.resume();
        isPlaying = true;
        document.getElementById('play-pause').textContent = '⏸';
    }
}

async function previousTrack() {
    if (!cdInfo || !currentTrack) return;
    
    const prevTrackNumber = currentTrack - 1;
    if (prevTrackNumber >= 1) {
        await playTrack(prevTrackNumber);
    }
}

async function nextTrack() {
    if (!cdInfo || !currentTrack) return;
    
    const nextTrackNumber = currentTrack + 1;
    if (nextTrackNumber <= cdInfo.tracks.length) {
        await playTrack(nextTrackNumber);
    }
}

// Polling Management
function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    pollingInterval = setInterval(() => loadCDInfo().catch(console.error), CHECK_INTERVAL);
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// Cleanup Functions
async function cleanupResources() {
    try {
        stopPolling();
        if (isPlaying) {
            await stopTrack();
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

function initializeCleanupHandlers() {
    if (cleanupInitialized) return;
    cleanupInitialized = true;

    ['pagehide', 'unload', 'beforeunload'].forEach(event => {
        window.addEventListener(event, cleanupResources);
    });
}

function initializeKeyboardControls() {
    let lastKeyPress = 0;
    const DEBOUNCE_TIME = 200;

    document.addEventListener('keydown', async (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        const now = Date.now();
        if (now - lastKeyPress < DEBOUNCE_TIME) {
            return;
        }
        lastKeyPress = now;

        try {
            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    await playPause();
                    break;
                case 'Escape':
                    await stopTrack();
                    break;
                case 'ArrowLeft':
                    await previousTrack();
                    break;
                case 'ArrowRight':
                    await nextTrack();
                    break;
                case 'KeyR':
                    if (cdInfo && cdInfo.tracks.length > 0) {
                        await playTrack(1);
                    }
                    break;
            }
        } catch (error) {
            console.error("Error in keyboard control:", error);
        }
    });
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function updateControls(enabled) {
    const buttons = document.querySelectorAll('.control-button');
    buttons.forEach(button => {
        button.disabled = !enabled;
    });
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    if (isInitialized) return;
    isInitialized = true;
    console.log("Initializing CD player...");

    initializeCleanupHandlers();
    initializeKeyboardControls();

    document.getElementById('prev-button').addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await previousTrack();
        } catch (error) {
            console.error("Error in previousTrack:", error);
        }
    });

    document.getElementById('play-pause').addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await playPause();
        } catch (error) {
            console.error("Error in playPause:", error);
        }
    });

    document.getElementById('stop-button').addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await stopTrack();
        } catch (error) {
            console.error("Error in stopTrack:", error);
        }
    });

    document.getElementById('next-button').addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await nextTrack();
        } catch (error) {
            console.error("Error in nextTrack:", error);
        }
    });

    document.getElementById('progress-bar').addEventListener('click', function(e) {
        if (!audioSource || !audioContext || !currentBuffer) return;
        
        const progressBar = this.getBoundingClientRect();
        const clickPosition = (e.clientX - progressBar.left) / progressBar.width;
        const newTime = clickPosition * currentBuffer.duration;
        
        audioSource.stop();
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = currentBuffer;
        audioSource.connect(audioContext.destination);
        audioSource.start(0, newTime);
        startTime = audioContext.currentTime - newTime;
        updateProgress();
    });

    loadCDInfo().then(() => {
        console.log("Initial CD info loaded");
        updateControls(true);
    }).catch(error => {
        console.error("Error loading initial CD info:", error);
    });
    
    startPolling();
});
