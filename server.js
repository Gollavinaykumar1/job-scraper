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

// ─── Shine.com Scraper (replaces Indeed / Fresherworld) ──────────────────────
// Shine.com — major Indian job portal, no IP blocking, domcontentloaded works

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const roleSlug = role.toLowerCase().replace(/\s+/g, '-');
    const locSlug = location.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.shine.com/job-search/${roleSlug}-jobs-in-${locSlug}`;

    console.log(`Shine: loading "${role}" in "${location}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const pageTitle = await page.title();
    console.log(`Shine: page title = "${pageTitle}"`);

    await page.waitForSelector('.jobCard, .job-card, [class*="jobCard"], [class*="job-card"], .srpJobCard', { timeout: 10000 }).catch(() => {});

    const classes = await page.evaluate(() => {
      const els = document.querySelectorAll('[class]');
      const found = new Set();
      els.forEach(el => {
        el.className.toString().split(' ').forEach(c => {
          if (c && (c.toLowerCase().includes('job') || c.toLowerCase().includes('card'))) found.add(c);
        });
      });
      return [...found].slice(0, 20).join(', ');
    });
    console.log(`Shine: job-related classes = ${classes}`);

    let cards = [];
    for (const sel of [
      '.jobCard', '.srpJobCard', '[class*="jobCard"]', '[class*="job-card"]',
      '.job-card', 'article[class*="job"]', 'li[class*="job"]',
      '[data-jobid]', '.shine-job', '.jobItem', '.job_list_item'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Shine: using "${sel}", found ${cards.length} cards`); break; }
    }

    console.log(`Shine: found ${cards.length} cards`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval('h2, h3, [class*="title"], [class*="jobtitle"], a[href*="job"]', el => el.textContent.trim()).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;
        const company = await card.$eval('[class*="company"], [class*="employer"], [class*="comp"]', el => el.textContent.trim()).catch(() => 'Unknown');
        const jobUrl = await card.$eval('a', el => el.href).catch(() => null);
        if (!jobUrl) continue;
        const fullUrl = jobUrl.startsWith('http') ? jobUrl : `https://www.shine.com${jobUrl}`;
        jobs.push({ title, company, location, url: fullUrl, description: `${title} at ${company} in ${location}. Apply on Shine.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }

    if (jobs.length === 0) {
      console.log('Shine: trying link fallback');
      const links = await page.$$('a[href*="/job-detail/"], a[href*="/jobs/"]');
      console.log(`Shine: found ${links.length} job links`);
      for (const link of links.slice(0, maxJobs * 3)) {
        try {
          const text = (await link.textContent() || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.shine.com${href}`;
          jobs.push({ title: text, company: 'See listing', location, url: jobUrl, description: `${text} - Apply on Shine.` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    }

    console.log(`Shine: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`Shine error:`, err.message); }
  return jobs;
}

// ─── Naukri.com Scraper (replaces Google Jobs / TimesJobs) ───────────────────
// Naukri — India's largest job portal, domcontentloaded + 3s wait is enough

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const roleSlug = role.toLowerCase().replace(/\s+/g, '-');
    const locSlug = location.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.naukri.com/${roleSlug}-jobs-in-${locSlug}`;

    console.log(`Naukri: loading "${role}" in "${location}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const pageTitle = await page.title();
    console.log(`Naukri: page title = "${pageTitle}"`);

    await page.waitForSelector('article.jobTuple, .jobTuple, [class*="jobTuple"], .srp-jobtuple-wrapper', { timeout: 10000 }).catch(() => {});

    const classes = await page.evaluate(() => {
      const els = document.querySelectorAll('[class]');
      const found = new Set();
      els.forEach(el => {
        el.className.toString().split(' ').forEach(c => {
          if (c && (c.toLowerCase().includes('job') || c.toLowerCase().includes('tuple') || c.toLowerCase().includes('card'))) found.add(c);
        });
      });
      return [...found].slice(0, 20).join(', ');
    });
    console.log(`Naukri: job-related classes = ${classes}`);

    let cards = [];
    for (const sel of [
      'article.jobTuple', '.jobTuple', '[class*="jobTuple"]',
      '.srp-jobtuple-wrapper', '[class*="srp-jobtuple"]',
      '.cust-job-tuple', 'article[class*="job"]',
      '.job-tuple', '[class*="job-tuple"]', 'li.jobTupleHeader'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Naukri: using "${sel}", found ${cards.length} cards`); break; }
    }

    console.log(`Naukri: found ${cards.length} cards`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval('a.title, .title, h2 a, h2, [class*="title"] a', el => el.textContent.trim()).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;
        const company = await card.$eval('.companyInfo a, [class*="company"] a, [class*="comp-name"]', el => el.textContent.trim()).catch(() => 'Unknown');
        const jobUrl = await card.$eval('a.title, a[href*="naukri.com"], a[href*="job-listings"]', el => el.href).catch(() => null);
        if (!jobUrl) continue;
        const fullUrl = jobUrl.startsWith('http') ? jobUrl : `https://www.naukri.com${jobUrl}`;
        jobs.push({ title, company, location, url: fullUrl, description: `${title} at ${company} in ${location}. Apply on Naukri.` });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }

    if (jobs.length === 0) {
      console.log('Naukri: trying link fallback');
      const links = await page.$$('a[href*="naukri.com"][href*="job-listings"], a[href*="/job-listings-"]');
      console.log(`Naukri: found ${links.length} job links`);
      for (const link of links.slice(0, maxJobs * 3)) {
        try {
          const text = (await link.textContent() || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.naukri.com${href}`;
          jobs.push({ title: text, company: 'See listing', location, url: jobUrl, description: `${text} - Apply on Naukri.` });
          if (jobs.length >= maxJobs) break;
        } catch (_) {}
      }
    }

    console.log(`Naukri: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`Naukri error:`, err.message); }
  return jobs;
}

// ─── Company Career Pages ─────────────────────────────────────────────────────

const COMPANY_CAREERS = [
  { name: 'Infosys',   url: 'https://career.infosys.com/joblist',       origin: 'https://career.infosys.com' },
  { name: 'Wipro',     url: 'https://careers.wipro.com/careers-home/',   origin: 'https://careers.wipro.com' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global/en',   origin: 'https://careers.cognizant.com' },
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
            href.includes('job') || href.includes('career') || href.includes('position');
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    })).newPage();
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    })).newPage();
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
