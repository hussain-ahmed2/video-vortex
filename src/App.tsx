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
    const cleanTitle = (ytMeta?.title || pageInfo.title).replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_');
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
    <div className="w-[420px] min-h-[520px] max-h-[600px] bg-slate-950 text-slate-50 flex flex-col font-sans antialiased">
      {/* Header */}
      <header className="p-4 pb-3 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="p-2 rounded-xl bg-purple-600/20 border border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.2)]"
            >
              <Zap size={18} className="text-purple-400 fill-purple-400/20" />
            </motion.div>
            <div>
              <h1 className="text-base font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-blue-400">
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
              <div className="px-2 py-0.5 rounded-full bg-purple-500/10 border border-purple-500/20">
                <span className="text-[10px] font-bold text-purple-400">{videos.length}</span>
              </div>
            )}
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => { setIsLoading(true); fetchData(); }}
              className="rounded-full hover:bg-white/5 h-8 w-8"
            >
              <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </header>

      {/* YouTube Meta Banner */}
      {isYouTube && ytMeta && (
        <div className="px-4 pt-3">
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl overflow-hidden border border-white/5"
          >
            <div className="relative h-24 bg-slate-900">
              <img 
                src={ytMeta.thumbnail} 
                className="w-full h-full object-cover opacity-40"
                alt=""
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <h2 className="text-[11px] font-bold text-white leading-tight line-clamp-2 mb-1">
                  {ytMeta.title}
                </h2>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-slate-400 font-medium">{ytMeta.channelName}</span>
                  <span className="text-[9px] text-slate-600">•</span>
                  <span className="text-[9px] text-slate-500 font-mono">{ytMeta.duration}</span>
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
            <Loader2 size={24} className="text-purple-400 animate-spin" />
            <p className="text-[11px] text-slate-500 font-medium">
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
                        <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-2 px-1 flex items-center gap-1.5">
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
                        <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-2 px-1 flex items-center gap-1.5">
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
                    <div className="relative">
                      <motion.div 
                        animate={{ scale: [1, 1.2, 1], opacity: [0.15, 0.4, 0.15] }}
                        transition={{ duration: 3, repeat: Infinity }}
                        className="absolute inset-0 bg-purple-500/20 blur-3xl rounded-full"
                      />
                      <Video size={40} className="text-slate-800 relative z-10" />
                    </div>
                    <div className="text-center space-y-1 relative z-10">
                      <p className="text-xs font-bold text-slate-400">No media detected</p>
                      <p className="text-[10px] text-slate-600 max-w-[200px] leading-relaxed">
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
      <footer className="px-4 py-3 border-t border-white/5 bg-slate-950/80 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={11} className="text-emerald-500" />
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Secure Downloader</span>
        </div>
        <div className="px-2 py-0.5 rounded-full bg-slate-900 border border-white/5">
           <span className="text-[9px] font-bold text-slate-600">v1.1.0</span>
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
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: idx * 0.03 }}
    >
      <Card className="bg-white/[0.03] border-white/[0.04] hover:border-purple-500/20 transition-all group overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="flex items-center gap-3 px-3 py-2.5">
            {/* Type Icon */}
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
              isAudio 
                ? 'bg-blue-500/10 border border-blue-500/15' 
                : 'bg-purple-500/10 border border-purple-500/15'
            }`}>
              {isAudio 
                ? <Music size={16} className="text-blue-400" />
                : <Film size={16} className="text-purple-400" />
              }
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 flex items-center gap-2">
              {/* Quality */}
              {video.quality && (
                <Badge variant="outline" className={`shrink-0 text-[10px] h-5 px-2 font-bold ${
                  isAudio
                    ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                    : 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                }`}>
                  {video.quality}
                </Badge>
              )}
              {/* Mime */}
              <span className="text-[9px] text-slate-600 font-mono truncate">
                {video.mime || video.type}
              </span>
              {/* Size */}
              {video.size && (
                <div className="flex items-center gap-1 shrink-0 ml-auto">
                  <HardDrive size={9} className="text-slate-600" />
                  <span className="text-[9px] text-slate-500 font-medium">{video.size}</span>
                </div>
              )}
            </div>

            {/* Download Button */}
            {downloadState ? (
              <div className="shrink-0 w-9 h-9 flex items-center justify-center">
                {downloadState.state === 'complete' ? (
                  <CheckCircle2 size={16} className="text-emerald-400" />
                ) : downloadState.state === 'interrupted' ? (
                  <AlertCircle size={16} className="text-red-400" />
                ) : (
                  <Loader2 size={16} className="text-purple-400 animate-spin" />
                )}
              </div>
            ) : (
              <Button 
                size="icon"
                className="shrink-0 h-8 w-8 rounded-lg bg-gradient-to-br from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 border-none shadow-lg shadow-purple-500/10"
                onClick={() => onDownload(video)}
              >
                <Download size={14} />
              </Button>
            )}
          </div>

          {/* Progress Bar */}
          {downloadState && downloadState.state === 'in_progress' && (
            <div className="h-0.5 w-full bg-slate-900">
              <motion.div 
                className="h-full bg-gradient-to-r from-purple-500 to-blue-500"
                initial={{ width: 0 }}
                animate={{ 
                  width: downloadState.totalBytes > 0 
                    ? `${(downloadState.bytesReceived / downloadState.totalBytes) * 100}%` 
                    : '30%' 
                }}
                transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
};

export default App;
