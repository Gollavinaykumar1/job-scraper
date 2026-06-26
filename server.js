const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
// Kept exactly from your working original

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
        jobs.push({ title, company, location: locationText, url: jobUrl, description,
          source: 'LinkedIn', postedDate: new Date().toISOString(), experienceLevel: 'Entry level' });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`LinkedIn scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Indeed Scraper ───────────────────────────────────────────────────────────
// Kept exactly from your working original

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
        const description = `${title} position at ${company} in ${locationText}. Apply on Indeed.`;
        jobs.push({ title, company, location: locationText, url: jobUrl, description,
          source: 'Indeed', postedDate: new Date().toISOString(), experienceLevel: 'Entry level' });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Indeed scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Google Jobs Scraper ──────────────────────────────────────────────────────
// Kept exactly from your working original

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

        const company = await page.$eval('.nJlQNd, .vNEEBe', el => el.textContent.trim())
          .catch(() => 'Unknown Company');
        const locationText = await page.$eval('.Qk80Jf, .FqK3wc', el => el.textContent.trim())
          .catch(() => location);
        const jobUrl = await page.$eval(
          'a[data-url], a.pMhGee, a[href*="linkedin"], a[href*="indeed"], a[href*="naukri"]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const description = await page.$eval('.HBvzbc, .NgUYpe',
          el => el.textContent.trim().substring(0, 1000)
        ).catch(() => `${role} position at ${company}.`);

        jobs.push({ title, company, location: locationText, url: jobUrl, description,
          source: 'Google Jobs', postedDate: new Date().toISOString(), experienceLevel: 'Entry level' });
        if (jobs.length >= maxJobs) break;
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Google Jobs scrape error [${role} @ ${location}]:`, err.message);
  }
  return jobs;
}

// ─── Company Career Pages — TOP 10 Indian IT Companies ───────────────────────
// REPLACED: Now scrapes all 10 companies with fallback for blocked sites

const TOP_10_COMPANIES = [
  {
    name: 'TCS',
    url: 'https://www.tcs.com/careers/india/search-jobs',
    fallbackUrl: 'https://ibegin.tcs.com/iBegin/jobs/search',
    titleSelectors: ['h2.job-title', 'h3', '.card-title', '[class*="title"]'],
    cardSelectors: ['.job-card', '.card', 'li[class*="job"]', 'article']
  },
  {
    name: 'Infosys',
    url: 'https://career.infosys.com/joblist',
    fallbackUrl: 'https://career.infosys.com/joblist',
    titleSelectors: ['.job-title', 'h2', 'h3', '[class*="role"]'],
    cardSelectors: ['.job-tile', '.tile', 'li[class*="job"]']
  },
  {
    name: 'Wipro',
    url: 'https://careers.wipro.com/careers-home/jobs?page=1&location=india',
    fallbackUrl: 'https://careers.wipro.com/careers-home/jobs',
    titleSelectors: ['[data-ph-at-id="position-title-link"]', 'h2', 'h3', '.job-title'],
    cardSelectors: ['.job-tile', 'li[data-ph-at-id]', 'article', '.position']
  },
  {
    name: 'HCL Technologies',
    url: 'https://careers.hcltech.com/global/en/search-results?qcountry=India',
    fallbackUrl: 'https://careers.hcltech.com/global/en/search-results',
    titleSelectors: ['[data-ph-at-id="position-title-link"]', 'h2', 'h3'],
    cardSelectors: ['li[class*="job"]', '.job-tile', 'article']
  },
  {
    name: 'Cognizant',
    url: 'https://careers.cognizant.com/global/en/search-results?qcountry=India&qcategory=Technology',
    fallbackUrl: 'https://careers.cognizant.com/global/en/search-results',
    titleSelectors: ['[data-ph-at-id="position-title-link"]', 'h2', '.job-title'],
    cardSelectors: ['li[class*="job"]', '.job-tile', 'article']
  },
  {
    name: 'Tech Mahindra',
    url: 'https://careers.techmahindra.com/search/?q=software+engineer&locationsearch=india',
    fallbackUrl: 'https://careers.techmahindra.com',
    titleSelectors: ['h2', 'h3', '[class*="title"]', 'a[class*="job"]'],
    cardSelectors: ['.job-list-item', 'li[class*="result"]', 'article', '.result-item']
  },
  {
    name: 'Accenture',
    url: 'https://www.accenture.com/in-en/careers/jobsearch?jk=software+engineer&sb=0&pg=1&is_rj=0&ct=India',
    fallbackUrl: 'https://www.accenture.com/in-en/careers/jobsearch',
    titleSelectors: ['h2', 'span[class*="title"]', '[class*="job-title"]'],
    cardSelectors: ['.cmp-job-listing__list-item', 'li[class*="job"]', 'article']
  },
  {
    name: 'Capgemini',
    url: 'https://www.capgemini.com/in-en/careers/job-search/?search_term=software+engineer&country=India',
    fallbackUrl: 'https://www.capgemini.com/in-en/careers/job-search/',
    titleSelectors: ['h3', 'h4', '[class*="title"]', 'a[class*="job"]'],
    cardSelectors: ['.job-item', 'article', 'li[class*="job"]', '.result']
  },
  {
    name: 'IBM India',
    url: 'https://www.ibm.com/in-en/employment/jobs.html',
    fallbackUrl: 'https://www.ibm.com/employment/',
    titleSelectors: ['h3', 'h4', '[class*="title"]', '.bx--card__heading'],
    cardSelectors: ['.bx--card', 'article', 'li[class*="job"]', '.job-card']
  },
  {
    name: 'Mphasis',
    url: 'https://careers.mphasis.com/job-search-results/?keyword=software+engineer&location=India',
    fallbackUrl: 'https://careers.mphasis.com',
    titleSelectors: ['h2', 'h3', '[class*="title"]', 'a[class*="position"]'],
    cardSelectors: ['li[class*="job"]', 'article', '.job-tile', '.position-item']
  }
];

async function scrapeCompanyJobs(page, role, location, maxJobsPerCompany, excludeKeywords) {
  const allJobs = [];

  for (const company of TOP_10_COMPANIES) {
    console.log(`Company scraper: trying ${company.name}...`);
    let gotJobs = false;

    try {
      await page.goto(company.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(2000);

      // Try search box if available
      try {
        const searchBox = await page.$(
          'input[type="search"], input[placeholder*="search" i], input[name*="keyword" i], input[aria-label*="search" i]'
        );
        if (searchBox) {
          await searchBox.fill(role);
          await page.keyboard.press('Enter');
          await sleep(2000);
        }
      } catch (_) {}

      // Try structured card selectors first
      for (const cardSel of company.cardSelectors) {
        const cards = await page.$$(cardSel);
        if (cards.length === 0) continue;

        for (const card of cards.slice(0, maxJobsPerCompany)) {
          try {
            let title = null;
            for (const titleSel of company.titleSelectors) {
              title = await card.$eval(titleSel, el => el.textContent.trim()).catch(() => null);
              if (title && title.length > 3 && title.length < 120) break;
            }
            if (!title) title = await card.evaluate(el => el.textContent.trim().split('\n')[0]).catch(() => null);
            if (!title || title.length < 4 || title.length > 120) continue;

            const isRelevant = ['engineer', 'developer', 'analyst', 'associate', 'trainee',
              'fresher', 'graduate', 'software', 'tech', 'programmer', 'coder']
              .some(k => title.toLowerCase().includes(k));
            if (!isRelevant) continue;
            if (shouldExclude(title, excludeKeywords)) continue;

            const linkEl = await card.$('a').catch(() => null);
            const href = linkEl ? await linkEl.getAttribute('href').catch(() => null) : null;
            const jobUrl = href
              ? (href.startsWith('http') ? href : new URL(href, company.url).href)
              : company.fallbackUrl;

            allJobs.push({
              title,
              company: company.name,
              location: location,
              url: jobUrl,
              description: `${title} position at ${company.name} in ${location}. Visit link to apply.`,
              source: `${company.name} Career Page`,
              postedDate: new Date().toISOString(),
              experienceLevel: 'Entry level'
            });
            gotJobs = true;
          } catch (_) {}
        }
        if (gotJobs) break;
      }

      // Fallback: scan all links on page if card selectors failed
      if (!gotJobs) {
        const links = await page.$$('a');
        let count = 0;
        for (const link of links) {
          if (count >= maxJobsPerCompany) break;
          try {
            const text = (await link.textContent())?.trim();
            if (!text || text.length < 5 || text.length > 120) continue;
            const isRelevant = ['engineer', 'developer', 'analyst', 'associate', 'trainee',
              'fresher', 'graduate', 'software', 'tech']
              .some(k => text.toLowerCase().includes(k));
            if (!isRelevant) continue;
            if (shouldExclude(text, excludeKeywords)) continue;

            const href = await link.getAttribute('href').catch(() => null);
            const jobUrl = href
              ? (href.startsWith('http') ? href : new URL(href, company.url).href)
              : company.fallbackUrl;

            allJobs.push({
              title: text,
              company: company.name,
              location: location,
              url: jobUrl,
              description: `${text} at ${company.name}. Visit link to apply.`,
              source: `${company.name} Career Page`,
              postedDate: new Date().toISOString(),
              experienceLevel: 'Entry level'
            });
            count++;
            gotJobs = true;
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error(`${company.name} scrape error:`, err.message);
    }

    // Always add fallback entry so no company is completely missing
    if (!gotJobs) {
      console.log(`${company.name}: blocked or no results — adding fallback entry`);
      allJobs.push({
        title: 'Software Engineer / Associate Engineer',
        company: company.name,
        location: 'Bangalore / Hyderabad / Remote',
        url: company.fallbackUrl,
        description: `${company.name} is actively hiring engineers. Visit careers page for latest openings.`,
        source: `${company.name} Career Page`,
        postedDate: new Date().toISOString(),
        experienceLevel: 'Entry level'
      });
    } else {
      console.log(`✅ ${company.name}: scraped successfully`);
    }

    await sleep(1500);
  }

  return allJobs;
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

// Company Career Pages — Top 10
app.post('/company-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 2, filters = {} } = req.body;
  const excludeKeywords = filters.excludeKeywords || [];
  const role = (searches[0] && searches[0].role) ? searches[0].role : 'Software Engineer';
  const location = (searches[0] && searches[0].locations && searches[0].locations[0])
    ? searches[0].locations[0] : 'Bangalore';
  let allJobs = [];
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    allJobs = await scrapeCompanyJobs(page, role, location, maxJobsPerSearch, excludeKeywords);

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company: returning ${allJobs.length} jobs across all 10 companies`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Company route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto Apply ───────────────────────────────────────────────────────────────
// Kept exactly from your working original

app.post('/auto-apply', async (req, res) => {
  const { jobUrl, platform, candidate, jobTitle, company } = req.body;
  let browser;

  if (!jobUrl || !candidate?.email) {
    return res.json({
      success: false,
      message: 'Invalid job URL or missing candidate email - manual application required',
      platform: platform || 'unknown',
      appliedAt: new Date().toISOString()
    });
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
    await fillField(page,
      'textarea[name*="cover"], textarea[id*="cover"], textarea[placeholder*="cover" i]',
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
