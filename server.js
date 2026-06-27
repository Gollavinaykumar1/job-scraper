const express = require('express');
const { chromium } = require('playwright');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });
}

function shouldExclude(title, excludeKeywords = []) {
  const t = title.toLowerCase();
  return excludeKeywords.some(kw => t.includes(kw.toLowerCase()));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Fetch helper (native https, no extra deps) ───────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 20000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── LinkedIn Scraper ─────────────────────────────────────────────────────────

async function scrapeLinkedIn(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc   = encodeURIComponent(location);
    const url   = `https://www.linkedin.com/jobs/search/?keywords=${query}&location=${loc}&f_TPR=r86400&f_E=2%2C3&sortBy=DD`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    try {
      await page.click('button[action-type="ACCEPT"]', { timeout: 3000 });
      await sleep(500);
    } catch (_) {}

    await page.waitForSelector(
      '.jobs-search__results-list, .job-card-container, .base-card',
      { timeout: 15000 }
    ).catch(() => {});

    const cards = await page.$$('.job-card-container, .base-card');
    console.log(`LinkedIn: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval(
          '.job-card-list__title, .base-search-card__title',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '.job-card-container__primary-description, .base-search-card__subtitle',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        const locationText = await card.$eval(
          '.job-card-container__metadata-item, .job-search-card__location',
          el => el.textContent.trim()
        ).catch(() => location);

        const jobUrl = await card.$eval(
          'a.job-card-list__title, a.base-card__full-link',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const description = `${title} position at ${company} in ${locationText}. Apply on LinkedIn.`;
        jobs.push({ title, company, location: locationText, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`LinkedIn scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Naukri API (replaces Indeed scraper) ────────────────────────────────────
// Uses Naukri's internal search API used by their own website

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const keyword  = encodeURIComponent(role);
    const loc      = encodeURIComponent(location);
    const apiUrl   = `https://www.naukri.com/jobapi/v3/search?noOfResults=${maxJobs * 3}&urlType=search_by_keyword&searchType=adv&keyword=${keyword}&location=${loc}&pageNo=1&experience=0&k=${keyword}&l=${loc}&seoKey=${role.toLowerCase().replace(/\s+/g,'-')}-jobs-in-${location.toLowerCase().replace(/\s+/g,'-')}`;

    console.log(`Naukri API: searching "${role}" in "${location}"`);

    const data = await fetchJson(apiUrl, {
      headers: {
        'appid': '109',
        'systemid': 'Naukri',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.naukri.com/',
        'x-http-method-override': 'GET'
      }
    });

    const jobList = data?.jobDetails || data?.jobs || [];
    console.log(`Naukri API: found ${jobList.length} jobs`);

    for (const job of jobList.slice(0, maxJobs)) {
      try {
        const title = job.title || job.jobTitle || '';
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        const company     = job.companyName || job.company || 'Unknown Company';
        const locationTxt = (job.placeholders?.find(p => p.type === 'location')?.label) || job.location || location;
        const jobUrl      = job.jdURL || job.jobUrl || `https://www.naukri.com/job-listings-${job.jobId}`;
        const description = job.jobDescription || `${title} at ${company} in ${locationTxt}`;

        jobs.push({ title, company, location: locationTxt, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Naukri API error [${role} @ ${location}]:`, err.message);
    // Fallback: try scraping with stealth headers
    try {
      console.log(`Naukri fallback: trying scrape for "${role}" in "${location}"`);
      const query = role.toLowerCase().replace(/\s+/g, '-');
      const loc   = location.toLowerCase().replace(/\s+/g, '-');
      const url   = `https://www.naukri.com/${query}-jobs-in-${loc}`;

      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      });

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);

      const cards = await page.$$('.srp-jobtuple-wrapper, article.jobTuple, [class*="jobTuple"]');
      console.log(`Naukri fallback: found ${cards.length} cards`);

      for (const card of cards.slice(0, maxJobs)) {
        try {
          const title = await card.$eval('a.title, .title a', el => el.textContent.trim()).catch(() => null);
          if (!title || shouldExclude(title, excludeKeywords)) continue;
          const company     = await card.$eval('.comp-name, a.comp-name', el => el.textContent.trim()).catch(() => 'Unknown');
          const locationTxt = await card.$eval('.loc-wrap span, .locWdth', el => el.textContent.trim()).catch(() => location);
          const jobUrl      = await card.$eval('a.title', el => el.href).catch(() => null);
          if (!jobUrl) continue;
          jobs.push({ title, company, location: locationTxt, url: jobUrl, description: `${title} at ${company}` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    } catch (e2) {
      console.error('Naukri fallback also failed:', e2.message);
    }
  }
  return jobs;
}

// ─── Foundit API (replaces Google Jobs scraper) ───────────────────────────────
// Uses Foundit's search API

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const keyword = encodeURIComponent(role);
    const loc     = encodeURIComponent(location);
    const apiUrl  = `https://www.foundit.in/middleware/jobsearch/v1/search?query=${keyword}&location=${loc}&experienceRanges=0~1&limit=${maxJobs * 3}&offset=0`;

    console.log(`Foundit API: searching "${role}" in "${location}"`);

    const data = await fetchJson(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.foundit.in/',
        'Origin': 'https://www.foundit.in'
      }
    });

    const jobList = data?.jobSearchResponse?.data?.jobs || data?.jobs || data?.data?.jobs || [];
    console.log(`Foundit API: found ${jobList.length} jobs`);

    for (const job of jobList.slice(0, maxJobs)) {
      try {
        const title = job.designation || job.title || job.jobTitle || '';
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        const company     = job.companyName || job.company || 'Unknown Company';
        const locationTxt = job.location || job.city || location;
        const jobId       = job.jobId || job.id || '';
        const jobUrl      = job.applyUrl || job.jobUrl || `https://www.foundit.in/job/${jobId}`;
        const description = job.jobDescription || `${title} at ${company} in ${locationTxt}`;

        jobs.push({ title, company, location: locationTxt, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Foundit API error [${role} @ ${location}]:`, err.message);
    // Fallback: Shine.com scrape (simpler HTML, less bot protection)
    try {
      console.log(`Shine fallback: trying scrape for "${role}" in "${location}"`);
      const query = encodeURIComponent(role);
      const loc   = encodeURIComponent(location);
      const url   = `https://www.shine.com/job-search/${role.toLowerCase().replace(/\s+/g,'-')}-jobs-in-${location.toLowerCase().replace(/\s+/g,'-')}`;

      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/'
      });

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);

      const cards = await page.$$('.jobCard, [class*="jobCard"], .job-card, [class*="job-card"]');
      console.log(`Shine fallback: found ${cards.length} cards`);

      for (const card of cards.slice(0, maxJobs)) {
        try {
          const title = await card.$eval('h3, h2, .title, [class*="title"]', el => el.textContent.trim()).catch(() => null);
          if (!title || shouldExclude(title, excludeKeywords)) continue;
          const company     = await card.$eval('[class*="company"], [class*="Company"]', el => el.textContent.trim()).catch(() => 'Unknown');
          const locationTxt = await card.$eval('[class*="location"], [class*="Location"]', el => el.textContent.trim()).catch(() => location);
          const jobUrl      = await card.$eval('a', el => el.href).catch(() => null);
          if (!jobUrl) continue;
          jobs.push({ title, company, location: locationTxt, url: jobUrl, description: `${title} at ${company}` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    } catch (e2) {
      console.error('Shine fallback also failed:', e2.message);
    }
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
        if (searchBox) {
          await searchBox.fill(role);
          await page.keyboard.press('Enter');
          await sleep(1500);
        }
      } catch (_) {}
      const links = await page.$$('a');
      for (const link of links.slice(0, 50)) {
        try {
          const text = await link.textContent();
          if (!text || text.trim().length < 5) continue;
          const title = text.trim();
          if (
            !title.toLowerCase().includes('engineer') &&
            !title.toLowerCase().includes('developer') &&
            !title.toLowerCase().includes('software')
          ) continue;
          if (shouldExclude(title, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href) continue;
          const jobUrl = href.startsWith('http') ? href : new URL(href, company.url).href;
          jobs.push({ title, company: company.name, location, url: jobUrl, description: `${title} position at ${company.name} in ${location}.` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    } catch (err) {
      console.error(`Company scrape error [${company.name}]:`, err.message);
    }
  }
  return jobs;
}

// ─── Deduplicate ──────────────────────────────────────────────────────────────

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = j.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// LinkedIn Jobs
app.post('/linkedin-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [];
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`LinkedIn: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeLinkedIn(page, search.role, location, maxJobsPerSearch, excludeKeywords);
        allJobs.push(...jobs);
        await sleep(1000);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`LinkedIn: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('LinkedIn route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Naukri Jobs (route stays /indeed-jobs — no n8n changes needed)
app.post('/indeed-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [];
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Naukri: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeIndeed(page, search.role, location, maxJobsPerSearch, excludeKeywords);
        allJobs.push(...jobs);
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Naukri: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Naukri route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Foundit Jobs (route stays /google-jobs — no n8n changes needed)
app.post('/google-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [];
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Foundit: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeGoogleJobs(page, search.role, location, maxJobsPerSearch, excludeKeywords);
        allJobs.push(...jobs);
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Foundit: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Foundit route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Company Career Pages
app.post('/company-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  let allJobs = [];
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    for (const search of searches) {
      const location = (search.locations || ['Bangalore'])[0];
      console.log(`Company: scraping "${search.role}" in "${location}"`);
      const jobs = await scrapeCompanyJobs(page, search.role, location, maxJobsPerSearch, excludeKeywords);
      allJobs.push(...jobs);
      await sleep(1000);
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Company route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto Apply ───────────────────────────────────────────────────────────────

app.post('/auto-apply', async (req, res) => {
  const { jobUrl, platform, candidate, jobTitle, company } = req.body;
  let browser;
  if (!jobUrl || !candidate?.email) {
    return res.status(400).json({ error: 'jobUrl and candidate.email are required' });
  }
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    console.log(`Auto-apply: ${platform} | ${jobTitle} at ${company} | ${jobUrl}`);
    if (platform === 'linkedin') {
      await applyLinkedIn(page, jobUrl, candidate);
    } else if (platform === 'indeed') {
      await applyIndeed(page, jobUrl, candidate);
    } else {
      await applyGeneric(page, jobUrl, candidate);
    }
    await browser.close();
    res.json({ success: true, message: `Applied to ${jobTitle} at ${company}`, platform, jobUrl, appliedAt: new Date().toISOString() });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Auto-apply error:', err);
    res.json({ success: false, message: err.message, platform, jobUrl, appliedAt: new Date().toISOString() });
  }
});

async function applyLinkedIn(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const easyApplyBtn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]');
  if (!easyApplyBtn) throw new Error('No Easy Apply button found');
  await easyApplyBtn.click();
  await sleep(2000);
  await fillField(page, 'input[name="phoneNumber"], input[id*="phone"]', candidate.phone || '');
  await fillField(page, 'input[id*="email"]', candidate.email);
  for (let i = 0; i < 5; i++) {
    const submitBtn = await page.$('button[aria-label="Submit application"]');
    if (submitBtn) { await submitBtn.click(); await sleep(2000); break; }
    const nextBtn = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (nextBtn) { await nextBtn.click(); await sleep(1500); } else break;
  }
}

async function applyIndeed(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const applyBtn = await page.$('button[id*="apply"], a[id*="apply"], button[class*="apply"]');
  if (!applyBtn) throw new Error('No apply button found on Indeed job page');
  await applyBtn.click();
  await sleep(2000);
  await fillField(page, 'input[name="email"], input[type="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[id*="name"]', candidate.fullName || '');
  const continueBtn = await page.$('button[type="submit"], button[id*="submit"]');
  if (continueBtn) await continueBtn.click();
}

async function applyGeneric(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const applySelectors = ['a[href*="apply"]', 'button:has-text("Apply")', 'a:has-text("Apply Now")', '[class*="apply"]', '[id*="apply"]'];
  for (const sel of applySelectors) {
    try { await page.click(sel, { timeout: 3000 }); await sleep(2000); break; } catch (_) {}
  }
  await fillField(page, 'input[type="email"], input[name="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[name="fullName"], input[id*="name"]', candidate.fullName || '');
  if (candidate.coverLetter) {
    await fillField(page, 'textarea[name*="cover"], textarea[id*="cover"], textarea[placeholder*="cover"]', candidate.coverLetter);
  }
}

async function fillField(page, selector, value) {
  if (!value) return;
  try {
    const el = await page.$(selector);
    if (el) await el.fill(value);
  } catch (_) {}
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Job scraper server running on port ${PORT}`);
  console.log('Endpoints: POST /linkedin-jobs | POST /indeed-jobs | POST /google-jobs | POST /company-jobs | POST /auto-apply | GET /health');
});
