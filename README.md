# Job Scraper Server — Railway Deployment

## Deploy in 3 steps

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial job scraper server"
git remote add origin https://github.com/YOUR_USERNAME/job-scraper.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `job-scraper` repo
4. Railway auto-detects the Dockerfile and builds it
5. Go to **Settings → Networking → Generate Domain**
6. Copy your domain — it looks like: `job-scraper-production-xxxx.up.railway.app`

### Step 3 — Update n8n
- Your n8n workflow already points to `https://job-scraper-production-ebd8.up.railway.app`
- If Railway gives you a different URL, update the 4 HTTP Request nodes in n8n with your new URL

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /linkedin-jobs | Scrape LinkedIn job listings |
| POST | /indeed-jobs | Scrape Indeed job listings |
| POST | /google-jobs | Scrape Google Jobs |
| POST | /company-jobs | Scrape company career pages (TCS, Infosys, Wipro, HCL, Cognizant) |
| POST | /auto-apply | Auto-fill and submit job applications |

## Request format (all scraper endpoints)
```json
{
  "searches": [
    { "role": "Software Engineer", "locations": ["Bangalore", "Remote India"] }
  ],
  "maxJobsPerSearch": 5,
  "filters": {
    "excludeKeywords": ["Senior", "Lead", "Manager"]
  }
}
```

## Response format
```json
[
  {
    "title": "Software Engineer",
    "company": "Acme Corp",
    "location": "Bangalore",
    "url": "https://linkedin.com/jobs/view/...",
    "description": "We are looking for..."
  }
]
```

## Auto-apply request format
```json
{
  "jobUrl": "https://linkedin.com/jobs/view/123",
  "platform": "linkedin",
  "candidate": {
    "fullName": "Your Name",
    "email": "you@email.com",
    "phone": "+91-9999999999",
    "resumeText": "...",
    "coverLetter": "..."
  },
  "jobTitle": "Software Engineer",
  "company": "Acme Corp"
}
```

## Notes
- The Playwright Microsoft base image (~1.5GB) is required for browser automation
- Railway's free tier may be slow on first boot — the Hobby plan ($5/mo) is recommended
- LinkedIn/Indeed may block scrapers intermittently; the server handles errors gracefully and returns whatever jobs it can get
- Auto-apply works best with LinkedIn Easy Apply jobs; other sites vary
