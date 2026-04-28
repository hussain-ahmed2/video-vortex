import { type VideoSource } from './lib/schemas';

const tabVideos: Map<number, VideoSource[]> = new Map();
const activeDownloads: Map<number, string> = new Map();

// ─── YouTube-specific: modify download headers ────────────────────────────
// When Chrome's download manager fetches a YouTube URL, inject proper headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.url.includes('googlevideo.com')) return {};

    const headers = details.requestHeaders || [];
    
    // Remove existing referer/origin and add correct ones
    const filtered = headers.filter(
      h => !['referer', 'origin'].includes(h.name.toLowerCase())
    );
    filtered.push({ name: 'Referer', value: 'https://www.youtube.com/' });
    filtered.push({ name: 'Origin', value: 'https://www.youtube.com' });

    return { requestHeaders: filtered };
  },
  { urls: ['*://*.googlevideo.com/*'] },
  ['blocking', 'requestHeaders']
);

// ─── Network sniffing for non-YouTube sites ───────────────────────────────
const videoExtensions = ['.mp4', '.webm', '.ogg', '.m4v', '.m3u8', '.mpd'];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return {};

    const urlLower = details.url.split('?')[0].toLowerCase();
    
    // Skip YouTube videoplayback — we handle YouTube via content script metadata
    if (details.url.includes('videoplayback')) return {};
    
    const isVideo = videoExtensions.some(ext => urlLower.endsWith(ext));
    if (!isVideo) return {};

    chrome.tabs.get(details.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      // Skip YouTube — handled separately
      if (tab.url?.includes('youtube.com') || tab.url?.includes('youtu.be')) return;

      let videos = tabVideos.get(details.tabId) || [];
      if (videos.some(v => v.url === details.url)) return;

      const ext = urlLower.split('.').pop() || 'unknown';
      let type: VideoSource['type'] = 'unknown';
      if (ext === 'm3u8') type = 'hls';
      else if (ext === 'mpd') type = 'dash';
      else if (['mp4', 'webm', 'ogg'].includes(ext)) type = ext as VideoSource['type'];

      videos.push({
        url: details.url,
        type,
        title: tab.title || 'Detected Video',
        timestamp: Date.now()
      });

      if (videos.length > 50) videos.shift();
      tabVideos.set(details.tabId, videos);
      updateBadge(details.tabId, videos.length);
    });

    return {};
  },
  { urls: ["<all_urls>"] }
);

// ─── Badge helper ─────────────────────────────────────────────────────────
function updateBadge(tabId: number, count: number) {
  chrome.action.setBadgeText({ tabId, text: count > 0 ? count.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#a855f7' });
}

// ─── Tab cleanup ──────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
});

// ─── Message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Popup asks for videos for a tab
  if (message.type === 'GET_VIDEOS') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) { sendResponse({ videos: [] }); return; }
    sendResponse({ videos: tabVideos.get(tabId) || [] });
  }

  // Popup asks to fetch YouTube data from content script
  else if (message.type === 'FETCH_YOUTUBE_DATA') {
    const tabId = message.tabId;
    if (!tabId) { sendResponse({ success: false }); return; }

    chrome.tabs.sendMessage(tabId, { type: 'GET_YOUTUBE_DATA' }, (response: any) => {
      if (chrome.runtime.lastError || !response?.youtubeData) {
        sendResponse({ success: false, error: 'Could not extract YouTube data' });
        return;
      }

      const yt = response.youtubeData;
      
      // Convert YouTube formats to our VideoSource format
      const videos: VideoSource[] = yt.formats.map((f: any) => ({
        url: f.url,
        type: f.type as VideoSource['type'],
        title: yt.title,
        thumbnail: yt.thumbnail,
        quality: f.quality,
        mime: f.mimeType,
        size: f.size,
        timestamp: Date.now()
      }));

      // Store for this tab
      tabVideos.set(tabId, videos);
      updateBadge(tabId, videos.length);

      sendResponse({ 
        success: true, 
        videos,
        meta: {
          title: yt.title,
          videoId: yt.videoId,
          channelName: yt.channelName,
          duration: yt.duration,
          thumbnail: yt.thumbnail
        }
      });
    });
    return true; // async
  }

  // Download request
  else if (message.type === 'DOWNLOAD_VIDEO') {
    const url = message.url;
    const filename = message.filename || `video_${Date.now()}.mp4`;

    chrome.downloads.download({
      url,
      filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else if (downloadId) {
        activeDownloads.set(downloadId, url);
        sendResponse({ success: true, downloadId });
      }
    });
    return true; // async
  }

  // URL changed notification from content script (YouTube SPA)
  else if (message.type === 'URL_CHANGED') {
    if (sender.tab?.id) {
      // Clear old data for this tab when navigating
      tabVideos.delete(sender.tab.id);
      updateBadge(sender.tab.id, 0);
    }
  }
});

// ─── Download progress ────────────────────────────────────────────────────
chrome.downloads.onChanged.addListener((delta) => {
  const downloadId = delta.id;
  
  chrome.downloads.search({ id: downloadId }, (results) => {
    if (!results?.[0]) return;
    const item = results[0];
    const url = activeDownloads.get(downloadId) || item.url;
    
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      downloadId,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      state: item.state,
      url
    }).catch(() => {});

    if (item.state === 'complete' || item.state === 'interrupted') {
      activeDownloads.delete(downloadId);
    }
  });
});
