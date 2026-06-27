const express = require('express');
const { chromium } = require('playwright');

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

// ─── Naukri Scraper (replaces Indeed) ────────────────────────────────────────

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = role.toLowerCase().replace(/\s+/g, '-');
    const loc   = location.toLowerCase().replace(/\s+/g, '-');
    const url   = `https://www.naukri.com/${query}-jobs-in-${loc}?experience=0`;

    console.log(`Naukri: loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Wait for job cards
    await page.waitForSelector(
      '.srp-jobtuple-wrapper, .jobTuple, article.jobTuple, .job-tuple, [class*="jobTuple"]',
      { timeout: 15000 }
    ).catch(() => console.warn('Naukri: job cards selector timeout'));

    await sleep(1000);

    const cards = await page.$$(
      '.srp-jobtuple-wrapper, .jobTuple, article.jobTuple, [class*="jobTuple"]'
    );

    console.log(`Naukri: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        // Title
        const title = await card.$eval(
          'a.title, .title a, [class*="title"] a, h2 a, a[class*="jobtitle"]',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        // Company
        const company = await card.$eval(
          'a.comp-name, .comp-name, [class*="companyName"], [class*="comp-name"]',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        // Location
        const locationText = await card.$eval(
          '.loc-wrap, [class*="location"], [class*="loc"] span, .locWdth',
          el => el.textContent.trim()
        ).catch(() => location);

        // URL
        const jobUrl = await card.$eval(
          'a.title, .title a, [class*="title"] a, h2 a',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const description = `${title} position at ${company} in ${locationText}. Apply on Naukri.`;
        jobs.push({ title, company, location: locationText, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Naukri scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Foundit Scraper (replaces Google Jobs) ───────────────────────────────────

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc   = encodeURIComponent(location);
    const url   = `https://www.foundit.in/srp/results?query=${query}&location=${loc}&experienceRanges=0~1`;

    console.log(`Foundit: loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Wait for job cards
    await page.waitForSelector(
      '.jobContainer, .card-apply-content, [class*="jobContainer"], .srpResultCardContainer, [class*="srpResultCard"]',
      { timeout: 15000 }
    ).catch(() => console.warn('Foundit: job cards selector timeout'));

    await sleep(1000);

    const cards = await page.$$(
      '.jobContainer, .card-apply-content, [class*="jobContainer"], .srpResultCardContainer, [class*="srpResultCard"]'
    );

    console.log(`Foundit: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        // Title
        const title = await card.$eval(
          '.jobTitle, [class*="jobTitle"], h3 a, h2 a, a[class*="title"]',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        // Company
        const company = await card.$eval(
          '.companyName, [class*="companyName"], [class*="company"] span',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        // Location
        const locationText = await card.$eval(
          '.locationText, [class*="location"], [class*="Location"] span',
          el => el.textContent.trim()
        ).catch(() => location);

        // URL
        const jobUrl = await card.$eval(
          'a[href*="/job/"], a[href*="/srp/"], h3 a, h2 a, a[class*="title"]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const fullUrl = jobUrl.startsWith('http') ? jobUrl : `https://www.foundit.in${jobUrl}`;
        const description = `${title} position at ${company} in ${locationText}. Apply on Foundit.`;
        jobs.push({ title, company, location: locationText, url: fullUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Foundit scrape error [${role} @ ${location}]:`, err.message);
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
        const searchBox = await page.$(
          'input[type="search"], input[placeholder*="search"], input[name*="keyword"]'
        );
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

          jobs.push({
            title,
            company: company.name,
            location,
            url: jobUrl,
            description: `${title} position at ${company.name} in ${location}.`
          });
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

// Naukri Jobs (route stays /indeed-jobs so n8n needs no changes)
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

// Foundit Jobs (route stays /google-jobs so n8n needs no changes)
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
    res.json({
      success: true,
      message: `Applied to ${jobTitle} at ${company}`,
      platform,
      jobUrl,
      appliedAt: new Date().toISOString()
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Auto-apply error:', err);
    res.json({
      success: false,
      message: err.message,
      platform,
      jobUrl,
      appliedAt: new Date().toISOString()
    });
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
    const nextBtn = await page.$(
      'button[aria-label="Continue to next step"], button[aria-label="Review your application"]'
    );
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
  const applySelectors = [
    'a[href*="apply"]', 'button:has-text("Apply")', 'a:has-text("Apply Now")',
    '[class*="apply"]', '[id*="apply"]'
  ];
  for (const sel of applySelectors) {
    try { await page.click(sel, { timeout: 3000 }); await sleep(2000); break; } catch (_) {}
  }
  await fillField(page, 'input[type="email"], input[name="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[name="fullName"], input[id*="name"]', candidate.fullName || '');
  if (candidate.coverLetter) {
    await fillField(
      page,
      'textarea[name*="cover"], textarea[id*="cover"], textarea[placeholder*="cover"]',
      candidate.coverLetter
    );
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
