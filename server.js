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
// FIX: Removed per-job page open for description — was causing 5min timeout
// Description is now built from card data only (fast)

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

        // FIX: Build description from card data — NO separate page load per job
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

// ─── Indeed Scraper ───────────────────────────────────────────────────────────
// FIX: Removed per-job page open for description

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query   = encodeURIComponent(role);
    const loc     = encodeURIComponent(location);
    const isIndia = !['new york','texas','california','washington','usa','remote usa']
      .some(x => location.toLowerCase().includes(x));
    const baseUrl = isIndia ? 'https://in.indeed.com' : 'https://www.indeed.com';
    const url     = `${baseUrl}/jobs?q=${query}&l=${loc}&fromage=1&sort=date`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const pageTitle = await page.title();
    if (
      pageTitle.toLowerCase().includes('captcha') ||
      pageTitle.toLowerCase().includes('robot')
    ) {
      console.warn('Indeed captcha detected, skipping');
      return jobs;
    }

    await page.waitForSelector(
      '[data-testid="job-title"], .jobTitle',
      { timeout: 15000 }
    ).catch(() => {});

    const cards = await page.$$('[data-testid="slider_item"], .job_seen_beacon, .resultContent');
    console.log(`Indeed: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        const title = await card.$eval(
          '[data-testid="job-title"] span, .jobTitle span',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[data-testid="company-name"], .companyName',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        const locationText = await card.$eval(
          '[data-testid="job-location"], .companyLocation',
          el => el.textContent.trim()
        ).catch(() => location);

        const relUrl = await card.$eval(
          '[data-testid="job-title"] a, .jobTitle a',
          el => el.getAttribute('href')
        ).catch(() => null);
        if (!relUrl) continue;

        const jobUrl = relUrl.startsWith('http') ? relUrl : `${baseUrl}${relUrl}`;

        // FIX: No separate page load per job
        const description = `${title} position at ${company} in ${locationText}. Apply on Indeed.`;

        jobs.push({ title, company, location: locationText, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Indeed scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Google Jobs Scraper ──────────────────────────────────────────────────────

async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(`${role} jobs in ${location}`);
    const url   = `https://www.google.com/search?q=${query}&ibp=htl;jobs&htivrt=jobs&htichips=date_posted:today`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    try {
      await page.click('[data-ved] .gws-plugins-horizon-jobs__tl-lif', { timeout: 5000 });
      await sleep(500);
    } catch (_) {}

    await page.waitForSelector('[jsname="MZArnb"], .PwjeAc', { timeout: 15000 }).catch(() => {});

    const cards = await page.$$('[jsname="MZArnb"], li.iFjolb');
    console.log(`Google Jobs: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards.slice(0, maxJobs)) {
      try {
        await card.click();
        await sleep(800);

        const title = await page.$eval(
          '.KLsYvd, [data-ved] h2.KLsYvd',
          el => el.textContent.trim()
        ).catch(async () =>
          await card.$eval('.BjJfJf, [class*="title"]', el => el.textContent.trim()).catch(() => null)
        );
        if (!title) continue;
        if (shouldExclude(title, excludeKeywords)) continue;

        const company = await page.$eval(
          '.nJlQNd, .vNEEBe',
          el => el.textContent.trim()
        ).catch(() => 'Unknown Company');

        const locationText = await page.$eval(
          '.Qk80Jf, .FqK3wc',
          el => el.textContent.trim()
        ).catch(() => location);

        const jobUrl = await page.$eval(
          'a[data-url], a.pMhGee, a[href*="linkedin"], a[href*="indeed"], a[href*="naukri"]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const description = await page.$eval(
          '.HBvzbc, .NgUYpe',
          el => el.textContent.trim().substring(0, 1000)
        ).catch(() => `${role} position at ${company}.`);

        jobs.push({ title, company, location: locationText, url: jobUrl, description });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Google Jobs scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Company Career Pages ─────────────────────────────────────────────────────
// FIX: Reduced to 3 companies and added 20s timeout per company

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

// Indeed Jobs
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
        console.log(`Indeed: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeIndeed(page, search.role, location, maxJobsPerSearch, excludeKeywords);
        allJobs.push(...jobs);
        await sleep(1500);
      }
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Indeed: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Indeed route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Google Jobs
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
        console.log(`Google Jobs: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeGoogleJobs(page, search.role, location, maxJobsPerSearch, excludeKeywords);
        allJobs.push(...jobs);
        await sleep(1500);
      }
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Google Jobs: returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Google Jobs route error:', err);
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
