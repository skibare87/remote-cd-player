// Global state
let currentTrack = null;
let isPlaying = false;
let cdInfo = null;
let lastCheckTime = 0;
let isInitialized = false;
let pollingInterval = null;
let cleanupInitialized = false;

const CHECK_INTERVAL = 5000; // 5 seconds

// Utility Functions
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function updateControls(enabled = true) {
    console.log("Updating controls. Enabled:", enabled, "Current track:", currentTrack, "CD Info:", !!cdInfo, "Is Playing:", isPlaying);
    const hasCD = !!cdInfo && cdInfo.tracks && cdInfo.tracks.length > 0;
    const trackSelected = currentTrack !== null;

    document.getElementById('play-pause').disabled = !hasCD;
    document.getElementById('stop-button').disabled = !hasCD || (!isPlaying && !trackSelected);
    document.getElementById('prev-button').disabled = !hasCD || !trackSelected || currentTrack <= 1;
    document.getElementById('next-button').disabled = !hasCD || !trackSelected || (currentTrack >= cdInfo.tracks.length);
}

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
        
        // Always stop the current playback before starting a new track
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
        
        const audio = new Audio();
        
        // ... (keep the existing event listeners) ...

        console.log(`Setting audio source to /api/cd/play/${trackNumber}`);
        audio.src = `/api/cd/play/${trackNumber}`;
        
        // Attempt to play immediately
        try {
            await audio.play();
            isPlaying = true;
            document.getElementById('play-pause').textContent = '⏸';
        } catch (playError) {
            console.error('Error starting playback:', playError);
            isPlaying = false;
            document.getElementById('play-pause').textContent = '▶';
        }
        
        updatePlaylistHighlight();
        updateControls(true);
        
        if (window.currentAudio) {
            window.currentAudio.pause();
            window.currentAudio.src = '';
            window.currentAudio = null;
        }
        window.currentAudio = audio;
        
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

function updatePlaylistHighlight() {
    document.querySelectorAll('.track-item').forEach((item, index) => {
        item.classList.toggle('playing', index + 1 === currentTrack);
    });
}

async function stopTrack() {
    try {
        stopPolling();
        
        if (window.currentAudio) {
            window.currentAudio.pause();
            window.currentAudio.src = '';
            window.currentAudio = null;
        }
        
        isPlaying = false;
        // Do not reset currentTrack here
        
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
    console.log("playPause called. Current state:", { cdInfo, currentTrack, isPlaying });
    if (!cdInfo) {
        console.log("No CD info available, cannot play");
        return;
    }
    
    if (!currentTrack) {
        console.log("No current track, starting from track 1");
        await playTrack(1);
        return;
    }
    
    if (isPlaying && window.currentAudio) {
        console.log("Pausing current track");
        window.currentAudio.pause();
        isPlaying = false;
        document.getElementById('play-pause').textContent = '▶';
    } else {
        console.log("Starting/resuming playback");
        await playTrack(currentTrack);
    }
}
async function previousTrack() {
    console.log("Previous track button clicked. Current state:", { cdInfo, currentTrack, isPlaying });
    if (!cdInfo || !currentTrack) {
        console.log("No CD info or current track, cannot move to previous track");
        return;
    }
    
    const prevTrackNumber = currentTrack - 1;
    if (prevTrackNumber >= 1) {
        console.log(`Moving to previous track: ${prevTrackNumber}`);
        await playTrack(prevTrackNumber);
    } else {
        console.log("Already at the first track");
    }
}
async function nextTrack() {
    console.log("Next track button clicked. Current state:", { cdInfo, currentTrack, isPlaying });
    if (!cdInfo || !currentTrack) {
        console.log("No CD info or current track, cannot move to next track");
        return;
    }
    
    const nextTrackNumber = currentTrack + 1;
    if (nextTrackNumber <= cdInfo.tracks.length) {
        console.log(`Moving to next track: ${nextTrackNumber}`);
        await playTrack(nextTrackNumber);
    } else {
        console.log("Already at the last track");
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

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && isPlaying) {
            playPause().catch(console.error);
        }
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

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    if (isInitialized) return;
    isInitialized = true;
    console.log("Initializing CD player...");

    // Initialize cleanup handlers
    initializeCleanupHandlers();

    // Add button event listeners
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

    // Initialize keyboard controls
    initializeKeyboardControls();
    
    // Initial load
    loadCDInfo().then(() => {
        console.log("Initial CD info loaded");
        updateControls(true);
    }).catch(error => {
        console.error("Error loading initial CD info:", error);
    });
    
    // Start polling
    startPolling();
});
