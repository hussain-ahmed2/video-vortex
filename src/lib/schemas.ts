import { z } from 'zod';

export const VideoSourceSchema = z.object({
  url: z.string(),
  type: z.enum(['video', 'audio', 'hls', 'dash', 'mp4', 'webm', 'ogg', 'unknown']),
  title: z.string(),
  thumbnail: z.string().optional(),
  quality: z.string().optional(),
  mime: z.string().optional(),
  size: z.string().optional(),
  timestamp: z.number()
});

export type VideoSource = z.infer<typeof VideoSourceSchema>;

export interface DownloadStatus {
  downloadId: number;
  bytesReceived: number;
  totalBytes: number;
  state: string;
  url: string;
}

export interface YouTubeMeta {
  title: string;
  videoId: string;
  channelName: string;
  duration: string;
  thumbnail: string;
}
