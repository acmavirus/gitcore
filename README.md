# GITCORE - Premium GitHub & Cloudflare Manager 🚀

**GITCORE** is a high-performance, aesthetically pleasing web application designed to manage both your GitHub repositories and Cloudflare DNS records with ease. Built with a "Cyber Premium" aesthetic, it combines glassmorphism, smooth animations, and powerful management tools.

![GITCORE Preview](https://via.placeholder.com/1200x600/0a0a0c/10b981?text=GITCORE+-+THE+FUTURE+OF+DEV+MANAGEMENT)

## ✨ Features

### 🐙 GitHub Management
- 🔐 **Secure Auth**: Connect instantly using your GitHub Personal Access Token (PAT).
- 📊 **Real-time Stats**: View Commit counts, Branch counts, Stars, and Forks at a glance.
- ⚡ **Quick Actions**:
  - **Inline Rename**: Edit repository names directly from the list.
  - **Fast Clone**: One-click to copy the `git clone` command to your clipboard.
  - **Bulk Management**: Select multiple repos to delete them in one go.
- 🔍 **Advanced Filtering**:
  - Filter by type: Public, Private, Sources, or Forks.
  - **Owner Filter**: Quickly switch between your own repos or those from organizations.
  - Real-time search by name or description.
- 📈 **Global Commits & Trending**: Explore recent global commits and trending repositories directly within the app.

### ☁️ Cloudflare Management
- 🔑 **Multi-Account Support**: Add and manage multiple Cloudflare accounts using Global API Keys.
- 🌐 **Unified Domains View**: Aggregated list of all domains across all your Cloudflare accounts and organizations.
- 🛠️ **Advanced DNS Control**: 
  - Manage A, AAAA, CNAME, TXT, MX, and NS records.
  - Toggle proxy status and adjust TTL.
- 🔄 **Bulk IP Replacement**: Automatically find and replace IP addresses for A records across multiple filtered domains in a single click.

### 🎨 Premium UI
- Dark mode, Glassmorphism design system.
- Custom Toast notifications and Confirmation Modals for a seamless, desktop-like experience.

## 🛠 Tech Stack

- **Core**: Vanilla JavaScript (ES6+)
- **Build Tool**: Vite
- **Styling**: Custom CSS (Modern Flexbox/Grid + Glassmorphism)
- **Icons**: Lucide Icons
- **Deployment**: Docker-Ready (Docker Compose)

## 🚀 Getting Started

### Prerequisites

- Docker Desktop (for containerized setup) OR Node.js installed
- A GitHub Personal Access Token (PAT) with `repo` and `user` scopes.
- A Cloudflare Global API Key (optional, for DNS features).

### Installation (Docker - Recommended)

1. **Clone the project**
   ```bash
   git clone https://github.com/your-username/app-github.git
   cd app-github
   ```

2. **Run with Docker Compose**
   ```bash
   docker compose up -d --build
   ```

3. Open `http://localhost:8900` in your browser.

### Installation (Node.js Local)

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Run locally**
   ```bash
   npm run dev
   ```

## 🔑 How to get API Keys?

### GitHub PAT
1. Go to **GitHub Settings** -> **Developer settings**.
2. Select **Personal access tokens** -> **Tokens (classic)**.
3. Click **Generate new token**.
4. Give it a name and select the `repo` (Full control) and `user` scopes.
5. Generate and copy the token into GITCORE!

### Cloudflare Global API Key
1. Dashboard -> My Profile -> **API Tokens**.
2. View the **Global API Key**.
3. Use your Cloudflare account email and the Global API Key in the app.

---

Built with ❤️ by AcmaTvirus
