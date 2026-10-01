import { useEffect, useState, useCallback } from "react";
import { 
  Download, 
  Video, 
  Globe, 
  RefreshCw, 
  ShieldCheck,
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Music,
  Film,
  HardDrive
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Card, 
  CardContent 
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { VideoSource, DownloadStatus, YouTubeMeta } from "./lib/schemas";

const App: React.FC = () => {
  const [videos, setVideos] = useState<VideoSource[]>([]);
  const [pageInfo, setPageInfo] = useState({ title: "Unknown Page", url: "" });
  const [isLoading, setIsLoading] = useState(true);
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadStatus>>({});
  const [ytMeta, setYtMeta] = useState<YouTubeMeta | null>(null);

  const isYouTube = pageInfo.url.includes("youtube.com/watch") || pageInfo.url.includes("youtu.be");

  const fetchData = useCallback(() => {
    if (typeof chrome === "undefined" || !chrome.tabs) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      const tabId = tab.id;

      // Get page info
      chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response) setPageInfo(response);
      });

      // Check if YouTube — use content script extraction
      const tabUrl = tab.url || '';
      if (tabUrl.includes('youtube.com/watch') || tabUrl.includes('youtu.be')) {
        chrome.runtime.sendMessage({ type: 'FETCH_YOUTUBE_DATA', tabId }, (response) => {
          if (response?.success && response.videos) {
            setVideos(response.videos);
            setYtMeta(response.meta || null);
          }
          setIsLoading(false);
        });
      } else {
        // Non-YouTube: get sniffed videos from background
        chrome.runtime.sendMessage({ type: 'GET_VIDEOS', tabId }, (response) => {
          if (response?.videos) {
            setVideos(response.videos);
          }
          setIsLoading(false);
        });
      }
    });
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);

    const messageListener = (message: any) => {
      if (message.type === 'DOWNLOAD_PROGRESS') {
        setDownloadStates(prev => ({
          ...prev,
          [message.url]: message
        }));
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      clearInterval(interval);
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [fetchData]);

  const downloadVideo = (video: VideoSource) => {
    const ext = video.mime?.includes('webm') ? 'webm' 
              : video.mime?.includes('mp4') ? 'mp4' 
              : video.type === 'audio' ? 'mp3' 
              : 'mp4';
    const sanitisedTitle = (ytMeta?.title || pageInfo.title)
      .replace(/[^a-z0-9\s]/gi, '')
      .trim()
      .replace(/\s+/g, '_');
    // The stem is guarded after sanitising, not before, because a title that is
    // only punctuation sanitises away to nothing just as an empty title does.
    // Without this the filename starts with the quality separator, so every
    // untitled page produces the same file and two downloads collide.
    const cleanTitle = sanitisedTitle || 'Unknown_Page';
    const qualitySuffix = video.quality ? `_${video.quality}` : '';
    const filename = `${cleanTitle}${qualitySuffix}.${ext}`;
    
    setDownloadStates(prev => ({
      ...prev,
      [video.url]: {
        downloadId: 0,
        bytesReceived: 0,
        totalBytes: -1,
        state: 'in_progress',
        url: video.url
      }
    }));

    chrome.runtime.sendMessage({ 
      type: 'DOWNLOAD_VIDEO', 
      url: video.url,
      filename
    });
  };

  const videoStreams = videos.filter(v => v.type !== 'audio');
  const audioStreams = videos.filter(v => v.type === 'audio');

  return (
    <div className="w-[420px] min-h-[520px] max-h-[600px] bg-background text-foreground flex flex-col font-sans antialiased">
      {/* Header */}
      <header className="p-4 pb-3 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-muted border border-border">
              <Zap size={18} className="text-muted-foreground fill-muted-foreground/20" />
            </div>
            <div>
              <h1 className="text-base font-black tracking-tight">
                VIDEO VORTEX
              </h1>
              <div className="flex items-center gap-1.5 opacity-50">
                <Globe size={9} />
                <span className="text-[9px] font-bold uppercase tracking-widest truncate max-w-[160px]">
                  {new URL(pageInfo.url || 'http://localhost').hostname}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {videos.length > 0 && (
              <div className="px-2 py-0.5 rounded-full bg-muted border border-border">
                <span className="text-[10px] font-bold text-muted-foreground">{videos.length}</span>
              </div>
            )}
            <Button 
              variant="ghost" 
              size="icon" 
              aria-label="Rescan this page"
              onClick={() => { setIsLoading(true); fetchData(); }}
              className="rounded-full hover:bg-muted h-8 w-8"
            >
              <RefreshCw size={13} className={isLoading ? "motion-safe:animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </header>

      {/* YouTube Meta Banner */}
      {isYouTube && ytMeta && (
        <div className="px-4 pt-3">
<motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.15, ease: 'easeOut' } }}
              className="rounded-xl overflow-hidden border border-border"
            >
            <div className="relative h-24 bg-muted">
              <img 
                src={ytMeta.thumbnail} 
                className="w-full h-full object-cover opacity-40"
                alt=""
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <h2 className="text-[11px] font-bold text-foreground leading-tight line-clamp-2 mb-1">
                  {ytMeta.title}
                </h2>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-muted-foreground font-medium">{ytMeta.channelName}</span>
                  <span className="text-[9px] text-subtle-foreground">•</span>
                  <span className="text-[9px] text-subtle-foreground font-mono">{ytMeta.duration}</span>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 p-4 pt-3 flex flex-col overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Loader2 size={24} className="text-muted-foreground motion-safe:animate-spin" />
            <p className="text-[11px] text-subtle-foreground font-medium">
              {isYouTube ? 'Extracting YouTube formats...' : 'Scanning for media...'}
            </p>
          </div>
        ) : (
          <ScrollArea className="flex-1 pr-2">
            <div className="flex flex-col gap-3 pb-2">
              <AnimatePresence mode="popLayout">
                {videos.length > 0 ? (
                  <>
                    {/* Video Streams */}
                    {videoStreams.length > 0 && (
                      <div>
                        <p className="text-[9px] font-bold text-subtle-foreground uppercase tracking-widest mb-2 px-1 flex items-center gap-1.5">
                          <Film size={10} /> Video ({videoStreams.length})
                        </p>
                        <div className="flex flex-col gap-1.5">
                          {videoStreams.map((video, idx) => (
                            <StreamCard 
                              key={`v-${idx}`} 
                              video={video} 
                              idx={idx} 
                              downloadState={downloadStates[video.url]}
                              onDownload={downloadVideo}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Audio Streams */}
                    {audioStreams.length > 0 && (
                      <div className="mt-1">
                        <p className="text-[9px] font-bold text-subtle-foreground uppercase tracking-widest mb-2 px-1 flex items-center gap-1.5">
                          <Music size={10} /> Audio ({audioStreams.length})
                        </p>
                        <div className="flex flex-col gap-1.5">
                          {audioStreams.map((video, idx) => (
                            <StreamCard 
                              key={`a-${idx}`} 
                              video={video} 
                              idx={idx} 
                              downloadState={downloadStates[video.url]}
                              onDownload={downloadVideo}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="py-16 flex flex-col items-center justify-center gap-4">
                    <Video size={40} className="text-muted" />
                    <div className="text-center space-y-1">
                      <p className="text-xs font-bold text-muted-foreground">No media detected</p>
                      <p className="text-[10px] text-subtle-foreground max-w-[200px] leading-relaxed">
                        {isYouTube 
                          ? 'Could not extract video data. Try refreshing the YouTube page first.'
                          : 'Play a video on the page and we\'ll catch the stream.'}
                      </p>
                    </div>
                  </div>
                )}
              </AnimatePresence>
            </div>
          </ScrollArea>
        )}
      </main>

      {/* Footer */}
      <footer className="px-4 py-3 border-t border-border bg-background/80 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={11} className="text-muted-foreground" />
          <span className="text-[9px] font-bold text-subtle-foreground uppercase tracking-widest">Secure Downloader</span>
        </div>
        <div className="px-2 py-0.5 rounded-full bg-muted border border-border">
           <span className="text-[9px] font-bold text-subtle-foreground">v1.1.0</span>
        </div>
      </footer>
    </div>
  );
};

// ─── Stream Card Component ────────────────────────────────────────────────
interface StreamCardProps {
  video: VideoSource;
  idx: number;
  downloadState?: DownloadStatus;
  onDownload: (video: VideoSource) => void;
}

const StreamCard: React.FC<StreamCardProps> = ({ video, idx, downloadState, onDownload }) => {
  const isAudio = video.type === 'audio';

  // Spec 0003: `totalBytes <= 0` is the only indeterminate case, and a known total
  // renders `Math.round(bytesReceived / totalBytes * 100)` clamped to 100. Both halves
  // were missing. `totalBytes` is the declared size while `bytesReceived` counts the
  // whole body, so a redirect or a resumed transfer reports more than promised and the
  // bar was free to run past its own track. `null` here means indeterminate, not zero,
  // so the two cases cannot be confused.
  const downloadTotal = downloadState?.totalBytes ?? 0;
  const downloadPercent = downloadTotal > 0
    ? Math.min(100, Math.max(0, Math.round(((downloadState?.bytesReceived ?? 0) / downloadTotal) * 100)))
    : null;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      // An explicit tween on each target, rather than a bare `transition={{ delay }}`.
      // Motion treats `delay` as orchestration only, so a transition carrying nothing
      // else is reported as undefined and `getDefaultTransition` steps in, which routes
      // `y` and `scale` to springs at damping ratios 0.559 and 0.640. Both overshoot, on
      // a list whose spec rule is "no bounce, no overshoot, no spring on a list". The
      // stagger delay lives inside the entrance transition because a per-target
      // transition replaces the component level one rather than adding to it.
      animate={{ opacity: 1, y: 0, transition: { duration: 0.15, ease: 'easeOut', delay: idx * 0.03 } }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15, ease: 'easeIn' } }}
    >
      <Card className="transition-colors group overflow-hidden shadow-none hover:ring-ring/50">
        <CardContent className="p-0">
          <div className="flex items-center gap-3 px-3 py-2.5">
            {/* Type Icon */}
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
              isAudio 
                ? 'bg-muted border border-border'
                : 'bg-muted border border-border'
            }`}>
              {isAudio 
                ? <Music size={16} className="text-muted-foreground" />
                : <Film size={16} className="text-muted-foreground" />
              }
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 flex items-center gap-2">
              {/* Quality */}
              {video.quality && (
                <Badge variant="outline" className={`shrink-0 text-[10px] h-5 px-2 font-bold ${
                  isAudio
                    ? 'bg-muted/50 text-muted-foreground'
                    : 'bg-muted/50 text-muted-foreground'
                }`}>
                  {video.quality}
                </Badge>
              )}
              {/* Mime */}
              <span className="text-[9px] text-subtle-foreground font-mono truncate">
                {video.mime || video.type}
              </span>
              {/* Size */}
              {video.size && (
                <div className="flex items-center gap-1 shrink-0 ml-auto">
                  <HardDrive size={9} className="text-subtle-foreground" />
                  <span className="text-[9px] text-subtle-foreground font-medium">{video.size}</span>
                </div>
              )}
            </div>

            {/* Download Button */}
            {downloadState ? (
              <div className="shrink-0 w-9 h-9 flex items-center justify-center">
                {downloadState.state === 'complete' ? (
                  <CheckCircle2 size={16} className="text-muted-foreground" />
                ) : downloadState.state === 'interrupted' ? (
                  <AlertCircle size={16} className="text-destructive" />
                ) : (
                  <Loader2 size={16} className="text-muted-foreground motion-safe:animate-spin" />
                )}
              </div>
            ) : (
              <Button 
                size="icon"
                aria-label={`Download ${isAudio ? 'audio' : 'video'}${video.quality ? ` ${video.quality}` : ''}`}
                className="shrink-0 h-8 w-8 rounded-lg border-none shadow-lg"
                onClick={() => onDownload(video)}
              >
                <Download size={14} />
              </Button>
            )}
          </div>

          {/* Progress Bar */}
          {downloadState && downloadState.state === 'in_progress' && (
            <div
              role="progressbar"
              aria-valuenow={downloadPercent ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-0.5 w-full bg-muted"
            >
              <motion.div
                className="h-full bg-muted-foreground"
                initial={{ width: 0 }}
                // An unknown total renders no fill rather than the fixed 30% this used
                // to show, which the spec calls a faked number: a transfer of unknown
                // length looked 30% done and never moved. The visible "size unknown"
                // wording is still owed by the row rebuild in slice 1.
                animate={{ width: `${downloadPercent ?? 0}%` }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
};

export default App;
