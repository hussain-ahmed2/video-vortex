// Video Vortex Background Service Worker
// Sniffs network traffic for video streams and files

interface VideoSource {
  url: string;
  type: string;
  title: string;
  timestamp: number;
}

const tabVideos: Map<number, VideoSource[]> = new Map();

// Supported formats
const videoExtensions = [
  '.mp4', '.webm', '.ogg', '.m4v', '.m4a', '.mp3', 
  '.m3u8', '.ts', '.mpd'
];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const url = details.url.split('?')[0].toLowerCase();
    const isVideo = videoExtensions.some(ext => url.endsWith(ext)) || 
                    details.url.includes('videoplayback') || // YouTube sniffing
                    details.url.includes('master.m3u8');

    if (isVideo) {
      let videos = tabVideos.get(details.tabId) || [];
      
      // Avoid duplicates
      if (!videos.some(v => v.url === details.url)) {
        videos.push({
          url: details.url,
          type: url.split('.').pop() || 'unknown',
          title: 'Detected Video', // Title will be updated by content script if possible
          timestamp: Date.now()
        });
        
        // Limit stored videos per tab
        if (videos.length > 50) videos.shift();
        tabVideos.set(details.tabId, videos);

        // Update badge
        chrome.action.setBadgeText({
          tabId: details.tabId,
          text: videos.length.toString()
        });
        chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
});

// Communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEOS') {
    const tabId = message.tabId || sender.tab?.id;
    sendResponse({ videos: tabVideos.get(tabId) || [] });
  } else if (message.type === 'DOWNLOAD_VIDEO') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || `video_${Date.now()}.mp4`,
      saveAs: true
    }, (downloadId) => {
      sendResponse({ success: !!downloadId, downloadId });
    });
    return true; // Keep message channel open for async response
  }
});
