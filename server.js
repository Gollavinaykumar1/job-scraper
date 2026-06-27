const express = require('express');
const { chromium } = require('playwright');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--single-process', '--disable-gpu'
    ]
  });
}

function shouldExclude(title, excludeKeywords = []) {
  const t = title.toLowerCase();
  return excludeKeywords.some(kw => t.includes(kw.toLowerCase()));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── LinkedIn Scraper ─────────────────────────────────────────────────────────

async function scrapeLinkedIn(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}&f_TPR=r86400&f_E=2%2C3&sortBy=DD`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    try { await page.click('button[action-type="ACCEPT"]', { timeout: 3000 }); await sleep(500); } catch (_) {}
    await page.waitForSelector('.jobs-search__results-list, .job-card-container, .base-card', { timeout: 15000 }).catch(() => {});
    const cards = await page.$$('.job-card-container, .base-card');
    console.log(`LinkedIn: found ${cards.length} cards for "${role}" in "${location}"`);
    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval('.job-card-list__title, .base-search-card__title', el => el.textContent.trim()).catch(() => null);
        if (!title || shouldExclude(title, excludeKeywords)) continue;
        const company = await card.$eval('.job-card-container__primary-description, .base-search-card__subtitle', el => el.textContent.trim()).catch(() => 'Unknown Company');
        const locationText = await card.$eval('.job-card-container__metadata-item, .job-search-card__location', el => el.textContent.trim()).catch(() => location);
        const jobUrl = await card.$eval('a.job-card-list__title, a.base-card__full-link', el => el.href).catch(() => null);
        if (!jobUrl) continue;
        jobs.push({ title, company, location: locationText, url: jobUrl, description: `${title} position at ${company} in ${locationText}. Apply on LinkedIn.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) { console.error(`LinkedIn scrape error [${role} @ ${location}]:`, err.message); }
  return jobs;
}

// ─── Naukri Scraper (replaces Indeed) ────────────────────────────────────────
// Uses Naukri's search API v2 with correct parameters

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];

  // Try Naukri API v2 with POST (what their website actually uses)
  try {
    const body = JSON.stringify({
      noOfResults: maxJobs * 3,
      urlType: 'search_by_keyword',
      searchType: 'adv',
      keyword: role,
      location: location,
      pageNo: 1,
      experience: 0,
      k: role,
      l: location
    });

    const data = await new Promise((resolve, reject) => {
      const req = https.request('https://www.naukri.com/jobapi/v3/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'appid': '109',
          'systemid': 'Naukri',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.naukri.com/',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 20000
      }, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON parse: ' + d.substring(0, 100))); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    const jobList = data?.jobDetails || data?.jobs || [];
    console.log(`Naukri API: found ${jobList.length} jobs for "${role}" in "${location}"`);

    for (const job of jobList.slice(0, maxJobs)) {
      try {
        const title = job.title || job.jobTitle || '';
        if (!title || shouldExclude(title, excludeKeywords)) continue;
        const company = job.companyName || job.company || 'Unknown Company';
        const loc = job.placeholders?.find(p => p.type === 'location')?.label || job.location || location;
        const jobUrl = job.jdURL || `https://www.naukri.com/job-listings-${job.jobId || ''}`;
        jobs.push({ title, company, location: loc, url: jobUrl, description: job.jobDescription || `${title} at ${company}` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }

    if (jobs.length > 0) return jobs;
  } catch (err) {
    console.error(`Naukri API error [${role} @ ${location}]:`, err.message);
  }

  // Fallback: Shine.com scrape (stable Indian portal)
  try {
    console.log(`Shine fallback: scraping "${role}" in "${location}"`);
    const roleSlug = role.toLowerCase().replace(/\s+/g, '-');
    const locSlug  = location.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.shine.com/job-search/${roleSlug}-jobs-in-${locSlug}`;

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.google.com/'
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Shine job card selectors
    const cards = await page.$$(
      '.jobCard, [class*="jobCard"], .job-card, [class*="job-card"], ' +
      'article[class*="job"], .job_listing, [class*="jobListing"], ' +
      'li[class*="job"], div[class*="JobCard"]'
    );
    console.log(`Shine fallback: found ${cards.length} cards`);

    for (const card of cards.slice(0, maxJobs * 3)) {
      try {
        // Title — try multiple selectors
        const title = await card.$eval(
          'h2, h3, [class*="title"], [class*="Title"], [class*="designation"], [class*="Designation"]',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        // Company
        const company = await card.$eval(
          '[class*="company"], [class*="Company"], [class*="employer"], [class*="Employer"]',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        // Location
        const locationText = await card.$eval(
          '[class*="location"], [class*="Location"], [class*="city"], [class*="City"]',
          el => el.textContent.trim()
        ).catch(() => location);

        // URL
        const jobUrl = await card.$eval('a', el => el.href).catch(() => null);
        if (!jobUrl || !jobUrl.startsWith('http')) continue;

        jobs.push({ title, company, location: locationText, url: jobUrl, description: `${title} at ${company} in ${locationText}. Apply on Shine.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }

    console.log(`Shine fallback: returning ${jobs.length} jobs`);
  } catch (e2) {
    console.error('Shine fallback failed:', e2.message);
  }

  return jobs;
}

// ─── Foundit/Shine Scraper (replaces Google Jobs) ────────────────────────────
// Shine.com found 381 cards — we fix the selector to extract jobs properly

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    console.log(`Shine: scraping "${role}" in "${location}"`);
    const roleSlug = role.toLowerCase().replace(/\s+/g, '-');
    const locSlug  = location.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.shine.com/job-search/${roleSlug}-jobs-in-${locSlug}`;

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.google.com/'
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Log all class names to find correct selector
    const allClasses = await page.evaluate(() => {
      const els = document.querySelectorAll('[class]');
      const classes = new Set();
      els.forEach(el => el.className.toString().split(' ').forEach(c => { if (c.toLowerCase().includes('job')) classes.add(c); }));
      return [...classes].slice(0, 30);
    });
    console.log('Shine job-related classes found:', allClasses.join(', '));

    // Try all possible card containers
    let cards = [];
    const cardSelectors = [
      '.jobCard', '[class*="jobCard"]', '.job-card', '[class*="job-card"]',
      'article[class*="job"]', '.job_listing', '[class*="jobListing"]',
      'li[class*="job"]', 'div[class*="JobCard"]', '.srpJobCard',
      '[class*="srpJob"]', '[class*="SrpJob"]', '[class*="listingCard"]',
      '[class*="ListingCard"]', 'ul.jobList > li', '[data-job-id]'
    ];

    for (const sel of cardSelectors) {
      cards = await page.$$(sel);
      if (cards.length > 0) {
        console.log(`Shine: using selector "${sel}", found ${cards.length} cards`);
        break;
      }
    }

    if (cards.length === 0) {
      // Last resort: get all links that look like job links
      console.log('Shine: trying link-based extraction');
      const links = await page.$$('a[href*="/job/"], a[href*="/jobs/"], a[href*="job-details"]');
      console.log(`Shine: found ${links.length} job links`);
      for (const link of links.slice(0, maxJobs * 3)) {
        try {
          const text = await link.textContent();
          const title = text?.trim();
          if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href) continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.shine.com${href}`;
          jobs.push({ title, company: 'See listing', location, url: jobUrl, description: `${title} - Apply on Shine.` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
      return jobs;
    }

    for (const card of cards.slice(0, maxJobs * 3)) {
      try {
        const title = await card.$eval(
          'h2, h3, [class*="title"], [class*="Title"], [class*="designation"], [class*="Designation"], a',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[class*="company"], [class*="Company"], [class*="employer"]',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        const locationText = await card.$eval(
          '[class*="location"], [class*="Location"], [class*="city"]',
          el => el.textContent.trim()
        ).catch(() => location);

        const jobUrl = await card.$eval('a', el => el.href).catch(() => null);
        if (!jobUrl || !jobUrl.startsWith('http')) continue;

        jobs.push({ title, company, location: locationText, url: jobUrl, description: `${title} at ${company} in ${locationText}. Apply on Shine.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }

    console.log(`Shine: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Shine scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Company Career Pages ─────────────────────────────────────────────────────

const COMPANY_CAREERS = [
  { name: 'Infosys',   url: 'https://career.infosys.com/joblist' },
  { name: 'Wipro',     url: 'https://careers.wipro.com/careers-home/' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global/en' },
];

async function scrapeCompanyJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  for (const company of COMPANY_CAREERS) {
    if (jobs.length >= maxJobs) break;
    try {
      await page.goto(company.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1000);
      try {
        const searchBox = await page.$('input[type="search"], input[placeholder*="search"], input[name*="keyword"]');
        if (searchBox) { await searchBox.fill(role); await page.keyboard.press('Enter'); await sleep(1500); }
      } catch (_) {}
      const links = await page.$$('a');
      for (const link of links.slice(0, 50)) {
        try {
          const text = await link.textContent();
          if (!text || text.trim().length < 5) continue;
          const title = text.trim();
          if (!title.toLowerCase().includes('engineer') && !title.toLowerCase().includes('developer') && !title.toLowerCase().includes('software')) continue;
          if (shouldExclude(title, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href) continue;
          const jobUrl = href.startsWith('http') ? href : new URL(href, company.url).href;
          jobs.push({ title, company: company.name, location, url: jobUrl, description: `${title} position at ${company.name} in ${location}.` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    } catch (err) { console.error(`Company scrape error [${company.name}]:`, err.message); }
  }
  return jobs;
}

// ─── Deduplicate ──────────────────────────────────────────────────────────────

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.url)) return false; seen.add(j.url); return true; });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/linkedin-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        allJobs.push(...await scrapeLinkedIn(page, search.role, location, maxJobsPerSearch, excludeKeywords));
        await sleep(1000);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`LinkedIn: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/indeed-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' })).newPage();
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        allJobs.push(...await scrapeIndeed(page, search.role, location, maxJobsPerSearch, excludeKeywords));
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Naukri/Shine: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/google-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', locale: 'en-US' })).newPage();
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        allJobs.push(...await scrapeGoogleJobs(page, search.role, location, maxJobsPerSearch, excludeKeywords));
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Shine: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/company-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
    for (const search of searches) {
      const location = (search.locations || ['Bangalore'])[0];
      allJobs.push(...await scrapeCompanyJobs(page, search.role, location, maxJobsPerSearch, excludeKeywords));
      await sleep(1000);
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto Apply ───────────────────────────────────────────────────────────────

app.post('/auto-apply', async (req, res) => {
  const { jobUrl, platform, candidate, jobTitle, company } = req.body;
  let browser;
  if (!jobUrl || !candidate?.email) return res.status(400).json({ error: 'jobUrl and candidate.email are required' });
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
    console.log(`Auto-apply: ${platform} | ${jobTitle} at ${company} | ${jobUrl}`);
    if (platform === 'linkedin') await applyLinkedIn(page, jobUrl, candidate);
    else if (platform === 'indeed') await applyIndeed(page, jobUrl, candidate);
    else await applyGeneric(page, jobUrl, candidate);
    await browser.close();
    res.json({ success: true, message: `Applied to ${jobTitle} at ${company}`, platform, jobUrl, appliedAt: new Date().toISOString() });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.json({ success: false, message: err.message, platform, jobUrl, appliedAt: new Date().toISOString() });
  }
});

async function applyLinkedIn(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const btn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]');
  if (!btn) throw new Error('No Easy Apply button found');
  await btn.click(); await sleep(2000);
  await fillField(page, 'input[name="phoneNumber"], input[id*="phone"]', candidate.phone || '');
  await fillField(page, 'input[id*="email"]', candidate.email);
  for (let i = 0; i < 5; i++) {
    const submit = await page.$('button[aria-label="Submit application"]');
    if (submit) { await submit.click(); await sleep(2000); break; }
    const next = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (next) { await next.click(); await sleep(1500); } else break;
  }
}

async function applyIndeed(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const btn = await page.$('button[id*="apply"], a[id*="apply"], button[class*="apply"]');
  if (!btn) throw new Error('No apply button found');
  await btn.click(); await sleep(2000);
  await fillField(page, 'input[name="email"], input[type="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[id*="name"]', candidate.fullName || '');
  const submit = await page.$('button[type="submit"], button[id*="submit"]');
  if (submit) await submit.click();
}

async function applyGeneric(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  for (const sel of ['a[href*="apply"]', 'button:has-text("Apply")', 'a:has-text("Apply Now")', '[class*="apply"]', '[id*="apply"]']) {
    try { await page.click(sel, { timeout: 3000 }); await sleep(2000); break; } catch (_) {}
  }
  await fillField(page, 'input[type="email"], input[name="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[name="fullName"], input[id*="name"]', candidate.fullName || '');
  if (candidate.coverLetter) await fillField(page, 'textarea[name*="cover"], textarea[id*="cover"]', candidate.coverLetter);
}

async function fillField(page, selector, value) {
  if (!value) return;
  try { const el = await page.$(selector); if (el) await el.fill(value); } catch (_) {}
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Job scraper server running on port ${PORT}`);
  console.log('Endpoints: POST /linkedin-jobs | POST /indeed-jobs | POST /google-jobs | POST /company-jobs | POST /auto-apply | GET /health');
});
