import { useEffect, useState } from "react";
import { 
  Download, 
  Video, 
  FileVideo, 
  Globe, 
  RefreshCw, 
  ExternalLink,
  ShieldCheck,
  Zap
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Card, 
  CardContent 
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface VideoSource {
  url: string;
  type: string;
  title: string;
  timestamp: number;
}

const App: React.FC = () => {
  const [videos, setVideos] = useState<VideoSource[]>([]);
  const [pageInfo, setPageInfo] = useState({ title: "Unknown Page", url: "" });
  const [isScanning, setIsScanning] = useState(true);

  const fetchVideos = () => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) {
          // Get page info from content script
          chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, (response) => {
            if (response) setPageInfo(response);
          });

          // Get videos from background
          chrome.runtime.sendMessage({ type: 'GET_VIDEOS', tabId }, (response) => {
            if (response && response.videos) {
              setVideos(response.videos);
            }
            setIsScanning(false);
          });
        }
      });
    }
  };

  useEffect(() => {
    fetchVideos();
    const interval = setInterval(fetchVideos, 2000);
    return () => clearInterval(interval);
  }, []);

  const downloadVideo = (video: VideoSource) => {
    const filename = `${pageInfo.title.replace(/[^a-z0-9]/gi, '_')}.${video.type}`;
    chrome.runtime.sendMessage({ 
      type: 'DOWNLOAD_VIDEO', 
      url: video.url,
      filename: filename
    });
  };

  return (
    <div className="w-[400px] min-h-[500px] bg-slate-950 text-slate-50 flex flex-col font-sans antialiased">
      {/* Header */}
      <header className="p-5 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="p-2.5 rounded-2xl bg-purple-600/20 border border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.2)]"
            >
              <Zap size={22} className="text-purple-400 fill-purple-400/20" />
            </motion.div>
            <div>
              <h1 className="text-lg font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-blue-400">
                VIDEO VORTEX
              </h1>
              <div className="flex items-center gap-1.5 opacity-50">
                <Globe size={10} />
                <span className="text-[10px] font-bold uppercase tracking-widest truncate max-w-[180px]">
                  {new URL(pageInfo.url || 'http://localhost').hostname}
                </span>
              </div>
            </div>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={fetchVideos}
            className="rounded-full hover:bg-white/5"
          >
            <RefreshCw size={14} className={isScanning ? "animate-spin" : ""} />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-4 flex flex-col gap-4 overflow-hidden">
        <ScrollArea className="flex-1 pr-3">
          <div className="flex flex-col gap-3 pb-4">
            <AnimatePresence mode="popLayout">
              {videos.length > 0 ? (
                videos.map((video, idx) => (
                  <motion.div
                    key={video.url + idx}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ delay: idx * 0.05 }}
                  >
                    <Card className="bg-white/5 border-white/5 hover:border-purple-500/30 transition-all group overflow-hidden shadow-none">
                      <CardContent className="p-0 flex flex-col">
                        <div className="p-3 flex gap-3 items-center">
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                            <FileVideo className="text-purple-400" size={20} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-xs font-bold text-slate-200 truncate leading-tight mb-1">
                              {video.title}
                            </h3>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" size="sm" className="bg-slate-900 border-none text-blue-400 font-mono">
                                {video.type.toUpperCase()}
                              </Badge>
                              <span className="text-[9px] text-slate-500 font-medium truncate max-w-[150px]">
                                {new URL(video.url).pathname.split('/').pop()}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="p-2 bg-white/[0.02] border-t border-white/5 flex gap-2">
                          <Button 
                            className="flex-1 h-8 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-[11px] font-bold tracking-wide rounded-lg border-none shadow-lg shadow-purple-500/10"
                            onClick={() => downloadVideo(video)}
                          >
                            <Download size={14} className="mr-2" /> DOWNLOAD
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 rounded-lg hover:bg-white/5 text-slate-400"
                            onClick={() => window.open(video.url, '_blank')}
                          >
                            <ExternalLink size={14} />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))
              ) : (
                <div className="py-20 flex flex-col items-center justify-center gap-4">
                  <div className="relative">
                    <motion.div 
                      animate={{ scale: [1, 1.2, 1], opacity: [0.2, 0.5, 0.2] }}
                      transition={{ duration: 3, repeat: Infinity }}
                      className="absolute inset-0 bg-purple-500/20 blur-3xl rounded-full"
                    />
                    <Video size={48} className="text-slate-800 relative z-10" />
                  </div>
                  <div className="text-center space-y-1 relative z-10">
                    <p className="text-sm font-bold text-slate-400">No videos detected</p>
                    <p className="text-[11px] text-slate-600 max-w-[200px]">
                      Try playing the video on the page to help us catch the stream.
                    </p>
                  </div>
                </div>
              )}
            </AnimatePresence>
          </div>
        </ScrollArea>
      </main>

      {/* Footer */}
      <footer className="p-4 border-t border-white/5 bg-slate-950/80 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={12} className="text-emerald-500" />
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Secure Downloader</span>
        </div>
        <div className="px-2 py-0.5 rounded-full bg-slate-900 border border-white/5">
           <span className="text-[9px] font-bold text-slate-600">v1.0.0</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
