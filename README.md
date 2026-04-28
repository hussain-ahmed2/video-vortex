# 🌪️ Video Vortex
> **High-performance media detection and one-click downloader for the modern web.**

Video Vortex is a premium Chrome extension designed to simplify media acquisition. It combines real-time network sniffing with DOM scraping to detect videos on any website, providing a sleek, unified interface for downloading content in its best available quality.

![Video Vortex Preview](https://raw.githubusercontent.com/placeholder/video-vortex/main/assets/preview.png)

## 🚀 Key Features

- **⚡ Live Stream Sniffing**: Advanced network interceptor catches `.mp4`, `.webm`, `.m3u8` (HLS), and `.ts` segments as they load.
- **📥 One-Click Secure Download**: Initiate downloads directly through the Chrome Download Manager for maximum speed and reliability.
- **🎨 Premium Vortex UI**: A stunning purple-to-blue dark mode dashboard with fluid animations powered by **Motion**.
- **🔍 Smart Metadata**: Automatically detects page titles and suggests clean filenames for your downloads.
- **🛡️ Privacy Focused**: All detection happens locally on your machine. No data ever leaves your browser.
- **📦 Multi-Format Support**: Detects everything from direct file links to complex adaptive streaming manifests.

## 🛠️ Tech Stack

- **Framework**: [React 19](https://react.dev/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [shadcn/ui](https://ui.shadcn.com/) (Standardized Variants)
- **Animations**: [Motion](https://motion.dev/)
- **Icons**: [Lucide React](https://lucide.dev/)

## 📦 Installation

### For Developers
1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/video-vortex.git
   cd video-vortex
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```

### Loading into Chrome
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer Mode**.
3. Click **Load unpacked** and select the `dist` folder generated in the project directory.

## 📖 How It Works

### The Vortex Engine
- **Background Worker**: Uses `chrome.webRequest` to sniff headers and URLs, identifying media streams that are otherwise hidden from the DOM.
- **Content Scraper**: Injected into every page to find static `<video>` and `<audio>` tags.
- **Messenger**: A robust messaging bridge synchronizes detected assets between the active tab and the popup interface.

## 🛡️ Privacy & Ethics
Video Vortex is designed for educational and personal archival purposes. Please respect the copyright and terms of service of the websites you visit. We do not support or encourage the unauthorized downloading of copyrighted material.

## 📄 License
MIT License. See `LICENSE` for details.

---
Built with ✨ by the Video Vortex Team.
