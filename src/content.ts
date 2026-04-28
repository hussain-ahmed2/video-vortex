// Video Vortex Content Script
// Extracts video metadata from pages, with YouTube-specific injection

interface YouTubeFormat {
  url: string;
  mimeType: string;
  qualityLabel?: string;
  quality: string;
  bitrate: number;
  contentLength?: string;
  itag: number;
  width?: number;
  height?: number;
  audioQuality?: string;
  audioSampleRate?: string;
}

// ─── YouTube Data Extraction ──────────────────────────────────────────────
// Content scripts run in an ISOLATED WORLD — they cannot access page JS variables.
// We must inject a <script> into the actual page to read `ytInitialPlayerResponse`.

function extractYouTubeData(): Promise<any> {
  return new Promise((resolve) => {
    // Listener for the response from injected script
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type === '__VORTEX_YT_DATA__') {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        resolve(event.data.payload);
      }
    };
    window.addEventListener('message', handler);

    // Timeout: if no response in 3 seconds, resolve null
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 3000);

    // Inject script into the PAGE context (not isolated world)
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          var pr = window.ytInitialPlayerResponse;
          if (!pr && document.querySelector('ytd-app')) {
            // Try to get from the player API
            var player = document.querySelector('#movie_player');
            if (player && player.getPlayerResponse) {
              pr = player.getPlayerResponse();
            }
          }
          window.postMessage({
            type: '__VORTEX_YT_DATA__',
            payload: pr ? JSON.parse(JSON.stringify(pr)) : null
          }, '*');
        } catch(e) {
          window.postMessage({
            type: '__VORTEX_YT_DATA__',
            payload: null
          }, '*');
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  });
}

function parseYouTubeResponse(playerResponse: any) {
  if (!playerResponse) return null;

  const videoDetails = playerResponse.videoDetails;
  const streamingData = playerResponse.streamingData;

  if (!videoDetails || !streamingData) return null;

  const title = videoDetails.title || document.title.replace(/ - YouTube$/i, '');
  const videoId = videoDetails.videoId;
  const thumbnail = videoDetails.thumbnail?.thumbnails?.pop()?.url || 
                    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const channelName = videoDetails.author || '';
  const lengthSeconds = parseInt(videoDetails.lengthSeconds || '0');
  const minutes = Math.floor(lengthSeconds / 60);
  const seconds = lengthSeconds % 60;
  const duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  // Combine regular formats (muxed) and adaptive formats (separate audio/video)
  const allFormats: YouTubeFormat[] = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || [])
  ];

  // Track which itags are muxed (have both audio+video)
  const muxedItags = new Set((streamingData.formats || []).map((f: YouTubeFormat) => f.itag));

  const formats = allFormats
    .filter((f: YouTubeFormat) => f.url) // Only formats with direct URLs (skip cipher-protected)
    .map((f: YouTubeFormat) => {
      const mime = f.mimeType?.split(';')[0] || 'unknown';
      const isAudio = mime.startsWith('audio');
      const isMuxed = muxedItags.has(f.itag);
      
      let quality = f.qualityLabel || f.quality || '';
      if (isAudio) {
        const kbps = Math.round(f.bitrate / 1000);
        quality = `${kbps}kbps`;
      }

      // Calculate file size
      let size = '';
      if (f.contentLength) {
        const bytes = parseInt(f.contentLength);
        if (bytes > 1024 * 1024) {
          size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        } else if (bytes > 1024) {
          size = `${(bytes / 1024).toFixed(0)} KB`;
        }
      }

      return {
        url: f.url,
        type: isAudio ? 'audio' : 'video',
        quality,
        mimeType: mime,
        size,
        itag: f.itag,
        isMuxed,
        hasAudio: isAudio || isMuxed
      };
    });

  return {
    title,
    videoId,
    thumbnail,
    channelName,
    duration,
    formats
  };
}

// ─── Generic video detection for non-YouTube sites ────────────────────────
function findPageVideos(): string[] {
  const videos: string[] = [];
  
  document.querySelectorAll('video').forEach(video => {
    if (video.src) videos.push(video.src);
    video.querySelectorAll('source').forEach(source => {
      if (source.src) videos.push(source.src);
    });
  });

  return videos.filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate
}

// ─── Message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      title: document.title,
      url: window.location.href
    });
    return false;
  }
  
  if (message.type === 'GET_YOUTUBE_DATA') {
    // Async extraction — inject into page and wait for response
    extractYouTubeData().then(playerResponse => {
      const parsed = parseYouTubeResponse(playerResponse);
      sendResponse({ youtubeData: parsed });
    });
    return true; // MUST return true for async sendResponse
  }
  
  if (message.type === 'GET_PAGE_VIDEOS') {
    sendResponse({ videos: findPageVideos() });
    return false;
  }

  return false;
});

// ─── YouTube SPA navigation detection ─────────────────────────────────────
let lastUrl = location.href;
const urlObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: location.href }).catch(() => {});
    }, 2000);
  }
});

if (document.body) {
  urlObserver.observe(document.body, { childList: true, subtree: true });
}
