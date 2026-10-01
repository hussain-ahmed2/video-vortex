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

// Spec 0003 pins this to the three values Chrome's downloads API actually reports,
// so a fourth state cannot arrive as an untyped string and reach the popup's
// switch. The popup's treatments for each value live in that spec's States table.
export type DownloadState = 'in_progress' | 'complete' | 'interrupted';

export interface DownloadStatus {
  downloadId: number;
  bytesReceived: number;
  totalBytes: number;
  state: DownloadState;
  url: string;
}

export interface YouTubeMeta {
  title: string;
  videoId: string;
  channelName: string;
  duration: string;
  thumbnail: string;
}
