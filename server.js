const express = require('express');
const { chromium } = require('playwright');
const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

// ─── UTILITIES ────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--single-process', '--disable-gpu', '--disable-blink-features=AutomationControlled'
    ]
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shouldExclude(title, excludeKeywords = []) {
  const t = (title || '').toLowerCase();
  return excludeKeywords.some(kw => t.includes(kw.toLowerCase()));
}

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = (j.title || '') + '|' + (j.company || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanSalary(text) {
  if (!text) return 'Not disclosed';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 100) return 'Not disclosed';
  if (/salary|lpa|lakh|per annum|₹|inr|ctc|pa|month|year|\d/i.test(cleaned)) return cleaned;
  return 'Not disclosed';
}

async function randomDelay(min = 1000, max = 3000) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

// Applies basic stealth patches to a browser context to reduce headless-browser
// fingerprinting signals (navigator.webdriver, plugin list, chrome object, etc.)
// This is free — no proxy service — and improves odds against basic bot checks,
// but will NOT reliably bypass full Cloudflare/Akamai challenge pages.
async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  });
}

// ─── LINKEDIN ─────────────────────────────────────────────────────────────────

function getLinkedInStorageState() {
  const raw = process.env.LINKEDIN_SESSION_STATE;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function scrapeLinkedIn(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}&f_TPR=r604800&f_E=2%2C3&sortBy=DD`;
    console.log(`LinkedIn: loading "${role}" in "${location}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    try { await page.click('button[action-type="ACCEPT"]', { timeout: 3000 }); await sleep(500); } catch (_) {}

    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(700);
    }

    await page.waitForSelector('.job-card-container, .base-card', { timeout: 15000 }).catch(() => {});
    const cards = await page.$$('.job-card-container, .base-card');
    console.log(`LinkedIn: found ${cards.length} cards`);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '.job-card-list__title, .base-search-card__title, [class*="job-card-list__title"]',
          el => el.innerText.trim()
        ).catch(() => null);
        if (!title || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '.job-card-container__primary-description, .base-search-card__subtitle',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const locationText = await card.$eval(
          '.job-card-container__metadata-item, .job-search-card__location',
          el => el.innerText.trim()
        ).catch(() => location);

        const jobUrl = await card.$eval(
          'a.job-card-list__title, a.base-card__full-link, a[class*="base-card__full-link"]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const salary = await card.$eval(
          '.job-card-container__salary-info, [class*="salary"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const postedDate = await card.$eval(
          'time, .job-card-container__listdate',
          el => el.getAttribute('datetime') || el.innerText.trim()
        ).catch(() => new Date().toISOString());

        jobs.push({
          title, company,
          location: locationText,
          url: jobUrl,
          salary: cleanSalary(salary),
          postedDate,
          source: 'LinkedIn',
          description: `${title} at ${company} in ${locationText}`,
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }
  } catch (err) {
    console.error(`LinkedIn error: ${err.message}`);
  }
  return jobs;
}

// ─── NAUKRI ───────────────────────────────────────────────────────────────────
// Uses the Naukri JSON API directly — no scraping, no blocks

async function scrapeNaukri(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    // Naukri has a public search API used by their own site
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location);
    const apiUrl = `https://www.naukri.com/jobapi/v3/search?noOfResults=${maxJobs * 2}&urlType=search_by_keyword&searchType=adv&keyword=${query}&location=${loc}&experience=0&jobAge=7&src=jobsearchDesk&pageNo=1`;

    console.log(`Naukri API: fetching "${role}" in "${location}"`);

    await page.setExtraHTTPHeaders({
      'Accept': 'application/json',
      'appid': '109',
      'systemid': 'Naukri',
      'Referer': 'https://www.naukri.com/',
    });

    const response = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const text = await page.evaluate(() => document.body.innerText);

    // DEBUG: log raw API response status + sample
    const apiStatus = response ? response.status() : 0;
    console.log('NAUKRI_API_DEBUG_STATUS:', apiStatus);
    console.log('NAUKRI_API_DEBUG_TEXT_LENGTH:', text.length);
    console.log('NAUKRI_API_DEBUG_TEXT_SAMPLE:', text.substring(0, 1500));

    let data;
    try { data = JSON.parse(text); } catch (_) {
      console.log('Naukri API JSON parse failed, trying HTML scrape fallback');
      return await scrapeNaukriHTML(page, role, location, maxJobs, excludeKeywords);
    }

    const jobList = data?.jobDetails || data?.jobs || [];
    console.log(`Naukri API: got ${jobList.length} jobs`);

    for (const job of jobList) {
      if (jobs.length >= maxJobs) break;
      const title = job.title || job.jobTitle || '';
      if (!title || shouldExclude(title, excludeKeywords)) continue;

      const salary = job.salary || job.salaryDetail || '';
      const skills = Array.isArray(job.tagsAndSkills) ? job.tagsAndSkills.join(', ') : (job.skills || '');
      const desc = job.jobDescription || job.snippets?.jobExperience || '';

      jobs.push({
        title,
        company: job.companyName || job.company || 'Unknown',
        location: (Array.isArray(job.placeholders) ? job.placeholders.find(p => p.type === 'location')?.label : null) || location,
        url: job.jdURL ? `https://www.naukri.com${job.jdURL}` : (job.jobUrl || `https://www.naukri.com/jobs`),
        salary: cleanSalary(salary),
        experience: job.experienceText || '0-2 Years',
        description: desc ? `${desc}\n\nSkills: ${skills}`.substring(0, 1500) : (skills ? `Skills: ${skills}` : `${title} at ${job.companyName}`),
        postedDate: job.createdDate || new Date().toISOString(),
        source: 'Naukri',
        experienceLevel: 'Entry level'
      });
    }

    if (jobs.length === 0) {
      console.log('Naukri API returned 0 jobs, trying HTML fallback');
      return await scrapeNaukriHTML(page, role, location, maxJobs, excludeKeywords);
    }

  } catch (err) {
    console.error(`Naukri API error: ${err.message}`);
    try { return await scrapeNaukriHTML(page, role, location, maxJobs, excludeKeywords); } catch (_) {}
  }
  return jobs;
}

async function scrapeNaukriHTML(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const roleSlug = role.toLowerCase().replace(/\s+/g, '-');
    const locSlug = location.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.naukri.com/${roleSlug}-jobs-in-${locSlug}?experience=0&jobAge=7`;
    console.log(`Naukri HTML: loading ${url}`);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-IN,en;q=0.9' });
    const htmlResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // ─── DEBUG BLOCK: tells us exactly what Naukri actually served ───
    const debugStatus = htmlResponse ? htmlResponse.status() : 0;
    const debugHTML = await page.content();
    const debugTitle = await page.title();
    console.log('NAUKRI_DEBUG_HTTP_STATUS:', debugStatus);
    console.log('NAUKRI_DEBUG_PAGE_TITLE:', debugTitle);
    console.log('NAUKRI_DEBUG_HTML_LENGTH:', debugHTML.length);
    console.log('NAUKRI_DEBUG_HTML_SAMPLE:', debugHTML.substring(0, 2000));
    // ─── END DEBUG BLOCK ───

    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await sleep(600); }

    // Try multiple selectors for Naukri's changing layout
    let cards = [];
    for (const sel of [
      '[class*="srp-jobtuple-wrapper"]', '[class*="jobTuple"]',
      'article.jobTuple', '.cust-job-tuple', '[class*="job-tuple"]',
      '[class*="list"] article', '.list article'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Naukri HTML: using "${sel}", ${cards.length} cards`); break; }
    }

    console.log('NAUKRI_DEBUG_CARDS_FOUND:', cards.length);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          'a.title, [class*="title"] a, h2 a, .jobTitle a, a[class*="title"], [class*="row1"] a',
          el => el.innerText.trim()
        ).catch(() => null);
        if (!title || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          'a.subTitle, [class*="companyInfo"] a, .comp-name, [class*="comp-name"], [class*="company-name"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const salary = await card.$eval(
          '[class*="salary"], li.salary, [class*="sal"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const locationText = await card.$eval(
          '[class*="location"], li.location, [class*="loc"]',
          el => el.innerText.trim()
        ).catch(() => location);

        const skills = await card.$eval(
          '[class*="tags"], ul.tags-gt, [class*="skill"]',
          el => el.innerText.replace(/\n/g, ', ').trim()
        ).catch(() => '');

        const jobUrl = await card.$eval(
          'a.title, a[class*="title"], h2 a, [class*="row1"] a',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        jobs.push({
          title, company,
          location: locationText.replace(/\n/g, ', ').trim(),
          url: jobUrl.startsWith('http') ? jobUrl : `https://www.naukri.com${jobUrl}`,
          salary: cleanSalary(salary),
          experience: '0-2 Years',
          description: skills ? `Skills required: ${skills}` : `${title} at ${company}`,
          postedDate: new Date().toISOString(),
          source: 'Naukri',
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }
    console.log(`Naukri HTML: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Naukri HTML error: ${err.message}`);
  }
  return jobs;
}

// ─── INTERNSHALA (replaces Foundit which 403s) ────────────────────────────────
// Internshala is extremely scraping-friendly and has real entry-level jobs

async function scrapeInternshala(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = role.toLowerCase().replace(/\s+/g, '-');
    const url = `https://internshala.com/jobs/${query}-jobs-in-${location.toLowerCase().replace(/\s+/g, '-')}`;
    console.log(`Internshala: loading "${role}" in "${location}"`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 600)); await sleep(500); }

    await page.waitForSelector('.internship_meta, .individual_internship, [class*="internship-list"]', { timeout: 10000 }).catch(() => {});

    let cards = [];
    for (const sel of [
      '.individual_internship', '[class*="individual_internship"]',
      '.internship_meta', '[data-internship_id]', '.container-fluid .internship'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Internshala: using "${sel}", ${cards.length} cards`); break; }
    }

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '.profile a, h3.job-internship-name a, .job-title a, [class*="profile"] a, h3 a',
          el => el.innerText.trim()
        ).catch(() => null);
        if (!title || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '.company-name a, .company_name a, [class*="company-name"], h4.company-name',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const locationText = await card.$eval(
          '.locations a, .location_link a, [class*="location"] a, .location span',
          el => el.innerText.trim()
        ).catch(() => location);

        const salary = await card.$eval(
          '.stipend, [class*="stipend"], .salary',
          el => el.innerText.trim()
        ).catch(() => null);

        const skills = await card.$eval(
          '.skill-container span, [class*="skill"] span',
          el => el.innerText.trim()
        ).catch(() => '');

        const jobUrl = await card.$eval(
          'a.view_detail_button, a[href*="/jobs/detail"], h3 a, .profile a',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const postedDate = await card.$eval(
          '.posted_by_container span, [class*="posted"], .status-success',
          el => el.innerText.trim()
        ).catch(() => '');

        jobs.push({
          title, company,
          location: locationText,
          url: jobUrl.startsWith('http') ? jobUrl : `https://internshala.com${jobUrl}`,
          salary: cleanSalary(salary),
          experience: 'Fresher / 0-2 Years',
          description: skills ? `Skills: ${skills}` : `${title} at ${company}`,
          postedDate,
          source: 'Internshala',
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }

    // Fallback: grab job links directly
    if (jobs.length === 0) {
      console.log('Internshala: trying link fallback');
      const links = await page.$$('a[href*="/jobs/detail/"], a[href*="internshala.com/jobs/"]');
      for (const link of links.slice(0, maxJobs * 2)) {
        if (jobs.length >= maxJobs) break;
        try {
          const text = (await link.innerText().catch(() => '')).trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          jobs.push({
            title: text, company: 'See job link', location,
            url: href.startsWith('http') ? href : `https://internshala.com${href}`,
            salary: 'Not disclosed', experience: 'Fresher',
            description: `${text} — Apply on Internshala`,
            postedDate: '', source: 'Internshala', experienceLevel: 'Entry level'
          });
        } catch (_) {}
      }
    }

    console.log(`Internshala: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Internshala error: ${err.message}`);
  }
  return jobs;
}

// ─── FOUNDIT (with Internshala fallback) ──────────────────────────────────────

async function scrapeFoundit(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location);
    const url = `https://www.foundit.in/srp/results?query=${query}&location=${loc}&experienceRanges=0~3&jobAge=7`;
    console.log(`Foundit: loading "${role}" in "${location}"`);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = response ? response.status() : 0;
    console.log(`Foundit: HTTP status ${status}`);

    if (status === 403 || status === 429) {
      console.log('Foundit blocked — switching to Internshala fallback');
      return await scrapeInternshala(page, role, location, maxJobs, excludeKeywords);
    }

    await sleep(3000);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 600)); await sleep(700); }

    let cards = [];
    for (const sel of [
      '[class*="cardContainer"]', '[class*="jobCard"]', '[class*="card-container"]',
      '[data-job-id]', 'article[class*="job"]', '[class*="jobItem"]',
      '[class*="srp-jobtuple"]', '[class*="resultItem"]'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Foundit: using "${sel}", ${cards.length} cards`); break; }
    }

    if (cards.length === 0) {
      console.log('Foundit: no cards found — switching to Internshala');
      return await scrapeInternshala(page, role, location, maxJobs, excludeKeywords);
    }

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '[class*="title"], h3, h2, a[class*="job"]',
          el => el.innerText.trim()
        ).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[class*="company"], [class*="companyName"], [class*="employer"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const salary = await card.$eval(
          '[class*="salary"], [class*="sal"], [class*="ctc"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const locationText = await card.$eval(
          '[class*="location"], [class*="loc"]',
          el => el.innerText.trim()
        ).catch(() => location);

        const jobUrl = await card.$eval(
          'a[href*="foundit"], a[href*="/job/"], a',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        jobs.push({
          title, company, location: locationText,
          url: jobUrl.startsWith('http') ? jobUrl : `https://www.foundit.in${jobUrl}`,
          salary: cleanSalary(salary), experience: '0-2 Years',
          description: `${title} at ${company} in ${locationText}`,
          postedDate: new Date().toISOString(),
          source: 'Foundit', experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }

    if (jobs.length === 0) {
      console.log('Foundit: 0 jobs extracted — switching to Internshala');
      return await scrapeInternshala(page, role, location, maxJobs, excludeKeywords);
    }

    console.log(`Foundit: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Foundit error: ${err.message} — trying Internshala`);
    try { return await scrapeInternshala(page, role, location, maxJobs, excludeKeywords); } catch (_) {}
  }
  return jobs;
}

// ─── INDEED ───────────────────────────────────────────────────────────────────
// Real Indeed.com scraper. Indeed uses Cloudflare bot protection — this uses
// free stealth patches only (no paid proxy). May get blocked; debug logging
// included so failures are diagnosable instead of guessed at.

async function scrapeIndeed(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location + ', India');
    const url = `https://in.indeed.com/jobs?q=${query}&l=${loc}&fromage=7&explvl=entry_level`;
    console.log(`Indeed: loading "${role}" in "${location}"`);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = response ? response.status() : 0;
    await sleep(2500);

    const debugTitle = await page.title();
    const debugHTML = await page.content();
    console.log('INDEED_DEBUG_HTTP_STATUS:', status);
    console.log('INDEED_DEBUG_PAGE_TITLE:', debugTitle);
    console.log('INDEED_DEBUG_HTML_LENGTH:', debugHTML.length);
    console.log('INDEED_DEBUG_HTML_SAMPLE:', debugHTML.substring(0, 1500));

    if (status === 403 || status === 429 || /cloudflare|verify you are human|additional verification/i.test(debugTitle + debugHTML.substring(0, 2000))) {
      console.log('Indeed: blocked by anti-bot protection (Cloudflare)');
      return jobs;
    }

    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await sleep(600); }

    let cards = [];
    for (const sel of [
      '.job_seen_beacon', '[data-jk]', '[class*="jobsearch-SerpJobCard"]',
      '[class*="result"]', 'td.resultContent', '.cardOutline'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Indeed: using "${sel}", ${cards.length} cards`); break; }
    }
    console.log('INDEED_DEBUG_CARDS_FOUND:', cards.length);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          'h2.jobTitle span, [class*="jobTitle"] span, h2 a span, .jcs-JobTitle',
          el => el.innerText.trim()
        ).catch(() => null);
        if (!title || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[data-testid="company-name"], .companyName, [class*="company"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const locationText = await card.$eval(
          '[data-testid="text-location"], .companyLocation, [class*="location"]',
          el => el.innerText.trim()
        ).catch(() => location);

        const salary = await card.$eval(
          '[class*="salary"], .salary-snippet',
          el => el.innerText.trim()
        ).catch(() => null);

        const jobUrl = await card.$eval(
          'h2.jobTitle a, a[id^="job_"], a[data-jk]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const snippet = await card.$eval(
          '[class*="jobSnippet"], .job-snippet',
          el => el.innerText.trim()
        ).catch(() => '');

        jobs.push({
          title, company,
          location: locationText,
          url: jobUrl.startsWith('http') ? jobUrl : `https://in.indeed.com${jobUrl}`,
          salary: cleanSalary(salary),
          experience: '0-2 Years',
          description: snippet || `${title} at ${company} in ${locationText}`,
          postedDate: new Date().toISOString(),
          source: 'Indeed',
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }
    console.log(`Indeed: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Indeed error: ${err.message}`);
  }
  return jobs;
}



const COMPANY_CAREERS = [
  { name: 'Infosys', url: 'https://career.infosys.com/joblist', origin: 'https://career.infosys.com' },
  { name: 'Wipro', url: 'https://careers.wipro.com/careers-home/', origin: 'https://careers.wipro.com' },
  { name: 'TCS', url: 'https://www.tcs.com/careers/tcs-careers-jobdetails', origin: 'https://www.tcs.com' },
  { name: 'HCL', url: 'https://www.hcltech.com/careers', origin: 'https://www.hcltech.com' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global/en', origin: 'https://careers.cognizant.com' },
];

const NON_JOB_PATHS = ['login','logout','signin','signup','register','account','profile',
  'about','contact','faq','privacy','terms','help','support','cookie','home','index'];

function isNonJobPath(href) {
  const h = href.toLowerCase();
  return NON_JOB_PATHS.some(p => h.includes(p));
}

function looksLikeJobTitle(text) {
  const t = text.trim();
  if (t.length < 8 || t.split(/\s+/).length < 2) return false;
  const roleWords = ['engineer','developer','software','analyst','architect','consultant',
    'specialist','associate','designer','administrator','scientist','tester','qa',
    'devops','intern','trainee','fresher','graduate','technology','technical',
    'programmer','full stack','backend','frontend','data','cloud','support'];
  return roleWords.some(w => t.toLowerCase().includes(w));
}

async function scrapeCompanyJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  for (const company of COMPANY_CAREERS) {
    const companyJobs = [];
    try {
      await page.goto(company.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);

      try {
        const searchBox = await page.$('input[type="search"], input[placeholder*="search" i], input[name*="keyword" i], input[placeholder*="job" i]');
        if (searchBox) {
          await searchBox.fill(role);
          await page.keyboard.press('Enter');
          await sleep(2500);
        }
      } catch (_) {}

      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 200)) {
        if (companyJobs.length >= maxJobs) break;
        try {
          const text = (await link.innerText().catch(() => '')).trim();
          const rawHref = await link.getAttribute('href');
          if (!rawHref || isNonJobPath(rawHref)) continue;
          if (!looksLikeJobTitle(text) || shouldExclude(text, excludeKeywords)) continue;
          const jobUrl = rawHref.startsWith('http') ? rawHref : `${company.origin}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;
          companyJobs.push({
            title: text, company: company.name, location,
            url: jobUrl, salary: 'As per industry standards',
            experience: '0-2 Years',
            description: `${text} at ${company.name}. Apply directly on their careers page.`,
            postedDate: new Date().toISOString().split('T')[0],
            source: `${company.name} Careers`, experienceLevel: 'Entry level'
          });
        } catch (_) {}
      }
      console.log(`Company: ${company.name} → ${companyJobs.length} jobs`);
    } catch (err) {
      console.error(`Company [${company.name}]: ${err.message}`);
    }
    jobs.push(...companyJobs);
  }
  return jobs;
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── LINKEDIN ─────────────────────────────────────────────────────────────────

app.post('/linkedin-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const storageState = getLinkedInStorageState();
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      ...(storageState ? { storageState } : {})
    });
    const page = await ctx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        const jobs = await scrapeLinkedIn(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []);
        allJobs.push(...jobs);
        await randomDelay(1500, 3000);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`LinkedIn total: ${allJobs.length}`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── NAUKRI (/indeed-jobs endpoint kept same so n8n workflow doesn't break) ───

app.post('/indeed-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
      viewport: { width: 1280, height: 800 },
      locale: 'en-IN'
    });
    await applyStealth(context);
    const page = await context.newPage();

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        const jobs = await scrapeIndeed(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []);
        allJobs.push(...jobs);
        await randomDelay(2500, 4500);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Indeed total: ${allJobs.length}`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── FOUNDIT + INTERNSHALA fallback (/google-jobs endpoint kept same) ─────────

app.post('/google-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' }
    })).newPage();

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        const jobs = await scrapeFoundit(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []);
        allJobs.push(...jobs);
        await randomDelay(2000, 4000);
      }
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Foundit/Internshala total: ${allJobs.length}`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── COMPANY CAREERS ──────────────────────────────────────────────────────────

app.post('/company-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    })).newPage();

    for (const search of searches) {
      const location = (search.locations || ['Bangalore'])[0];
      allJobs.push(...await scrapeCompanyJobs(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
      await sleep(1000);
    }
    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company total: ${allJobs.length}`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Endpoints: /health | /linkedin-jobs | /indeed-jobs | /google-jobs | /company-jobs');
});
