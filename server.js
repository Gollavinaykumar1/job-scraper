const express = require('express');
const { chromium } = require('playwright');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
           '--single-process','--disable-gpu']
  });
}

function shouldExclude(title, excludeKeywords = []) {
  const t = title.toLowerCase();
  return excludeKeywords.some(kw => t.includes(kw.toLowerCase()));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

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
        jobs.push({ title, company, location: locationText, url: jobUrl, description: `${title} at ${company} in ${locationText}. Apply on LinkedIn.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) { console.error(`LinkedIn error:`, err.message); }
  return jobs;
}

// ─── Indeed ───────────────────────────────────────────────────────────────────
// Using the EXACT approach that returned 16 links and 2 jobs in previous working deploy

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const isIndia = !['new york','texas','california','washington','usa','remote usa'].some(x => location.toLowerCase().includes(x));
    const baseUrl = isIndia ? 'https://in.indeed.com' : 'https://www.indeed.com';
    const url = `${baseUrl}/jobs?q=${encodeURIComponent(role)}&l=${encodeURIComponent(location)}&fromage=1&sort=date`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const pageTitle = await page.title();
    console.log(`Indeed: page title = "${pageTitle}"`);
    if (pageTitle.toLowerCase().includes('captcha') || pageTitle.toLowerCase().includes('robot')) {
      console.warn('Indeed: captcha detected');
      return jobs;
    }

    // Wait for job links with data-jk
    await page.waitForSelector('a[data-jk]', { timeout: 15000 }).catch(() => {});

    const jobLinks = await page.$$('a[data-jk]');
    console.log(`Indeed: found ${jobLinks.length} job links for "${role}" in "${location}"`);

    const seen = new Set();
    for (const link of jobLinks) {
      try {
        const jk = await link.getAttribute('data-jk');
        if (!jk || seen.has(jk)) continue;
        seen.add(jk);

        // Get title from span inside the anchor
        const title = await link.evaluate(el => {
          const span = el.querySelector('span[id], span[title], span') || el;
          return (span.textContent || '').trim();
        }).catch(() => null);

        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const jobUrl = `${baseUrl}/viewjob?jk=${jk}`;

        // Walk up DOM to find card container for company/location
        const company = await link.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            const c = node.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
            if (c) return c.textContent.trim();
            node = node.parentElement;
          }
          return 'Unknown Company';
        }).catch(() => 'Unknown Company');

        const locationText = await link.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            const l = node.querySelector('[data-testid="text-location"], .companyLocation, [class*="companyLocation"]');
            if (l) return l.textContent.trim();
            node = node.parentElement;
          }
          return '';
        }).catch(() => location);

        jobs.push({ title, company, location: locationText || location, url: jobUrl, description: `${title} at ${company} in ${locationText || location}. Apply on Indeed.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
    console.log(`Indeed: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`Indeed error:`, err.message); }
  return jobs;
}

// ─── TimesJobs Scraper (replaces Google Jobs) ─────────────────────────────────
// TimesJobs is an Indian job portal with stable HTML, no bot blocking on Railway

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location);
    const url = `https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=${query}&txtLocation=${loc}`;

    console.log(`TimesJobs: loading "${role}" in "${location}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Log page title to confirm it loaded
    const pageTitle = await page.title();
    console.log(`TimesJobs: page title = "${pageTitle}"`);

    // TimesJobs job cards
    await page.waitForSelector('li.clearfix.job-bx, .job-bx, [class*="job-bx"]', { timeout: 15000 }).catch(() => {});

    const cards = await page.$$('li.clearfix.job-bx, .job-bx');
    console.log(`TimesJobs: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval('h2 a, .job-title a, h2', el => el.textContent.trim()).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval('.joblist-comp-name, [class*="comp-name"], h3.joblist-comp-name', el => el.textContent.trim()).catch(() => 'Unknown Company');
        const locationText = await card.$eval('.srp-skills, [class*="location"], .loc', el => el.textContent.trim()).catch(() => location);
        const jobUrl = await card.$eval('h2 a, a.job-title', el => el.href).catch(() => null);

        if (!jobUrl) continue;
        jobs.push({ title, company, location: locationText, url: jobUrl, description: `${title} at ${company} in ${locationText}. Apply on TimesJobs.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
    console.log(`TimesJobs: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`TimesJobs error:`, err.message); }
  return jobs;
}

// ─── Company Career Pages ─────────────────────────────────────────────────────

const COMPANY_CAREERS = [
  { name: 'Infosys',   url: 'https://career.infosys.com/joblist',        origin: 'https://career.infosys.com' },
  { name: 'Wipro',     url: 'https://careers.wipro.com/careers-home/',    origin: 'https://careers.wipro.com' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global/en',    origin: 'https://careers.cognizant.com' },
];

async function scrapeCompanyJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  for (const company of COMPANY_CAREERS) {
    const companyJobs = [];
    try {
      await page.goto(company.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);
      try {
        const searchBox = await page.$('input[type="search"], input[placeholder*="search" i], input[name*="keyword" i], input[placeholder*="job" i]');
        if (searchBox) { await searchBox.fill(role); await page.keyboard.press('Enter'); await sleep(2000); }
      } catch (_) {}

      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 100)) {
        try {
          const text = (await link.textContent() || '').trim();
          const href = (await link.getAttribute('href') || '').toLowerCase();
          const textLower = text.toLowerCase();
          const isJobLink =
            textLower.includes('engineer') || textLower.includes('developer') ||
            textLower.includes('software') || textLower.includes('analyst') ||
            textLower.includes('architect') || textLower.includes('consultant') ||
            href.includes('job') || href.includes('career') || href.includes('position') ||
            href.includes('opening') || href.includes('vacancy');
          if (!isJobLink || text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const rawHref = await link.getAttribute('href');
          if (!rawHref) continue;
          const jobUrl = rawHref.startsWith('http') ? rawHref : `${company.origin}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;
          companyJobs.push({ title: text, company: company.name, location, url: jobUrl, description: `${text} at ${company.name}` });
          if (companyJobs.length >= maxJobs) break;
        } catch (_) {}
      }
      console.log(`Company: ${company.name} → ${companyJobs.length} jobs`);
    } catch (err) { console.error(`Company error [${company.name}]:`, err.message); }
    jobs.push(...companyJobs);
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
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`LinkedIn: scraping "${search.role}" in "${location}"`);
        allJobs.push(...await scrapeLinkedIn(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
        await sleep(1000);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`LinkedIn: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) { if (browser) await browser.close().catch(() => {}); res.status(500).json({ error: err.message }); }
});

app.post('/indeed-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    })).newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Indeed: scraping "${search.role}" in "${location}"`);
        allJobs.push(...await scrapeIndeed(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Indeed: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) { if (browser) await browser.close().catch(() => {}); res.status(500).json({ error: err.message }); }
});

app.post('/google-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    })).newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Google Jobs: scraping "${search.role}" in "${location}"`);
        allJobs.push(...await scrapeGoogleJobs(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
        await sleep(1500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Google Jobs: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) { if (browser) await browser.close().catch(() => {}); res.status(500).json({ error: err.message }); }
});

app.post('/company-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
    for (const search of searches) {
      const location = (search.locations || ['Bangalore'])[0];
      console.log(`Company: scraping "${search.role}" in "${location}"`);
      allJobs.push(...await scrapeCompanyJobs(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
      await sleep(1000);
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) { if (browser) await browser.close().catch(() => {}); res.status(500).json({ error: err.message }); }
});

// ─── Auto Apply ───────────────────────────────────────────────────────────────

app.post('/auto-apply', async (req, res) => {
  const { jobUrl, platform, candidate, jobTitle, company } = req.body;
  let browser;
  if (!jobUrl || !candidate?.email) return res.status(400).json({ error: 'jobUrl and candidate.email required' });
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' })).newPage();
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

app.listen(PORT, () => {
  console.log(`Job scraper server running on port ${PORT}`);
  console.log('Endpoints: POST /linkedin-jobs | POST /indeed-jobs | POST /google-jobs | POST /company-jobs | POST /auto-apply | GET /health');
});
