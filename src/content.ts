// Video Vortex Content Script
// Scrapes the DOM for video elements and sources

function findVideos() {
  const videos: string[] = [];
  
  // 1. Check <video> tags
  document.querySelectorAll('video').forEach(video => {
    if (video.src) videos.push(video.src);
    video.querySelectorAll('source').forEach(source => {
      if (source.src) videos.push(source.src);
    });
  });

  // 2. Check <iframe> tags (basic youtube/vimeo detection)
  document.querySelectorAll('iframe').forEach(iframe => {
    const src = iframe.src;
    if (src.includes('youtube.com/embed') || src.includes('player.vimeo.com/video')) {
      // These are harder to download directly due to CORS/Protection
      // but we can at least flag them
    }
  });

  return videos;
}

// Notify background about DOM-based videos
function reportVideos() {
  const urls = findVideos();
  if (urls.length > 0) {
    // This is a simplified example. In a real downloader, 
    // you'd send these to background to be validated.
  }
}

// Run on load and whenever DOM changes
reportVideos();
const observer = new MutationObserver(reportVideos);
observer.observe(document.body, { childList: true, subtree: true });

// Listen for requests from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      title: document.title,
      url: window.location.href
    });
  }
});
