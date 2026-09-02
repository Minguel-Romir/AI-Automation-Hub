
� TradeHub – AI-Powered Trading Command Center

# React + Node.js + Docker Starter

A fully containerized full-stack boilerplate featuring a React frontend and a Node.js/Express API, orchestrated with Docker Compose for zero-hassle local development.

## ✨ Features
- **Frontend:** React 18 with hot-reload (Port 3000)
- **Backend:** Node.js 20 + Express REST API (Port 5000)
- **Containerization:** Docker and Docker Compose for one-command setup
- **Live Reload:** Volume mounts sync code changes instantly
- **Health Check:** Built-in `/api/health` endpoint to verify API status

## 📁 Project Structure

For a complete directory tree and explanation of all files, see:
[`docs/Project-Structure.md`](docs/Project-Structure.md)

## 🚀 Quick Start

### Prerequisites
- Docker Desktop installed

### Running the App
```bash
# Clone the repository
git clone <your-repo-url>
cd <your-repo-folder>

# Build and start all services
docker-compose up --build
