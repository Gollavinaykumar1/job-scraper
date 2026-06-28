const express = require('express');
const { chromium } = require('playwright');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

// Generates a simple, plain PDF resume from the candidate's resume text and
// saves it to a temp file. Used to give applyGeneric something real to
// upload when a job form has a file input for the resume. This is NOT a
// substitute for the user's original formatted PDF - it's a plain text
// rendering, used only so automated forms that require a file don't fail
// outright. Returns the absolute file path, or null on failure.
async function generateResumePdf(candidate) {
  const text = (candidate.resumeText || '').trim();
  if (!text) {
    console.log('Resume PDF: no resumeText available, skipping generation');
    return null;
  }
  try {
    const tmpPath = path.join(os.tmpdir(), `resume-${Date.now()}.pdf`);
    const doc = new PDFDocument({ margin: 50 });
    const writeStream = fs.createWriteStream(tmpPath);
    doc.pipe(writeStream);

    doc.fontSize(16).text(candidate.fullName || 'Resume', { underline: true });
    doc.moveDown(0.5);
    if (candidate.email) doc.fontSize(10).text(`Email: ${candidate.email}`);
    if (candidate.phone) doc.fontSize(10).text(`Phone: ${candidate.phone}`);
    doc.moveDown(1);
    doc.fontSize(11).text(text, { align: 'left' });

    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`Resume PDF: generated at ${tmpPath}`);
    return tmpPath;
  } catch (err) {
    console.error('Resume PDF: generation failed:', err.message);
    return null;
  }
}

// Deletes a generated resume PDF after it's been used, so temp files don't
// pile up across runs.
function cleanupResumePdf(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) console.error('Resume PDF: cleanup failed:', err.message);
  });
}

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

// Randomized delay used for LinkedIn interactions specifically, to avoid the
// perfectly even timing that's a strong signal of automation. Defaults to a
// 1.5-3s pause; callers can pass a tighter or wider range for specific steps.
function humanPause(minMs = 1500, maxMs = 3000) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return sleep(ms);
}

// Loads the saved LinkedIn session (cookies + localStorage) from the
// LINKEDIN_SESSION_STATE environment variable, if it's set. Returns null
// if missing or invalid, so callers can fall back to a logged-out context
// instead of crashing.
function getLinkedInStorageState() {
  const raw = process.env.LINKEDIN_SESSION_STATE;
  if (!raw) {
    console.log('LinkedIn: no LINKEDIN_SESSION_STATE set, using logged-out session');
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    console.log('LinkedIn: loaded saved session from LINKEDIN_SESSION_STATE');
    return parsed;
  } catch (err) {
    console.error('LinkedIn: LINKEDIN_SESSION_STATE is not valid JSON, ignoring it:', err.message);
    return null;
  }
}

// Creates a browser context for LinkedIn, using the saved session if
// available so requests appear logged-in instead of as a guest.
async function newLinkedInContext(browser) {
  const storageState = getLinkedInStorageState();
  const contextOptions = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };
  if (storageState) contextOptions.storageState = storageState;
  return await browser.newContext(contextOptions);
}

// LinkedIn (unchanged - working)
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

// Shine.com - working
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

    await page.waitForSelector('.jdbigCard, [class*="jdbigCard"], [class*="bigCard"]', { timeout: 10000 }).catch(() => {});

    let cards = [];
    for (const sel of [
      '.jdbigCard', '[class*="jdbigCard"]', '[class*="bigCard"]',
      '[class*="jobCardNova"]', '[class*="jobCard"]'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Shine: using "${sel}", found ${cards.length} cards`); break; }
    }

    console.log(`Shine: total cards = ${cards.length}`);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '[class*="bigCardTopTitleHeading"], [class*="TitleHeading"], [class*="jdBigCardTopTitle"] h2, h2, h3',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[class*="bigCardTopCompany"], [class*="TopCompany"], [class*="company"]',
          el => el.textContent.trim()
        ).catch(() => 'Unknown');

        const jobUrl = await card.$eval(
          'a[href*="/job-detail/"], a[href*="shine.com/jobs"], a[href*="/jobs/"]',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const fullUrl = jobUrl.startsWith('http') ? jobUrl : `https://www.shine.com${jobUrl}`;
        jobs.push({ title, company, location, url: fullUrl, description: `${title} at ${company} in ${location}. Apply on Shine.` });
      } catch (_) {}
    }

    if (jobs.length === 0) {
      console.log('Shine: trying link fallback');
      const links = await page.$$('a[href*="/job-detail/"]');
      console.log(`Shine: found ${links.length} job detail links`);
      for (const link of links) {
        if (jobs.length >= maxJobs) break;
        try {
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          const text = (await link.evaluate(el => {
            const heading = el.closest('[class*="bigCard"]')?.querySelector('[class*="TitleHeading"], h2, h3');
            return heading ? heading.textContent.trim() : el.textContent.trim();
          }) || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.shine.com${href}`;
          jobs.push({ title: text, company: 'See listing', location, url: jobUrl, description: `${text} - Apply on Shine.` });
        } catch (_) {}
      }
    }

    console.log(`Shine: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`Shine error:`, err.message); }
  return jobs;
}

// Foundit (Monster India) - currently Access Denied on Railway IP
async function scrapeGoogleJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location);
    const url = `https://www.foundit.in/srp/results?query=${query}&location=${loc}&experienceRanges=0~3`;

    console.log(`Foundit: loading "${role}" in "${location}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const pageTitle = await page.title();
    console.log(`Foundit: page title = "${pageTitle}"`);

    await page.waitForSelector('.jobsearchresults, [class*="cardContainer"], [class*="jobCard"], .job-container', { timeout: 10000 }).catch(() => {});

    const classes = await page.evaluate(() => {
      const els = document.querySelectorAll('[class]');
      const found = new Set();
      els.forEach(el => {
        el.className.toString().split(' ').forEach(c => {
          if (c && (c.toLowerCase().includes('job') || c.toLowerCase().includes('card') || c.toLowerCase().includes('result'))) found.add(c);
        });
      });
      return [...found].slice(0, 25).join(', ');
    });
    console.log(`Foundit: job-related classes = ${classes}`);

    let cards = [];
    for (const sel of [
      '[class*="cardContainer"]', '[class*="jobCard"]', '[class*="card-container"]',
      '.jobsearchresults article', '[class*="job-card"]', '[class*="JobCard"]',
      '.srp-jobtuple', 'article[class*="job"]', '[class*="jobItem"]',
      '[class*="listItem"]', '[data-job-id]', '[class*="resultItem"]'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Foundit: using "${sel}", found ${cards.length} cards`); break; }
    }

    console.log(`Foundit: total cards = ${cards.length}`);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '[class*="title"], [class*="jobTitle"], [class*="job-title"], h2, h3, a[href*="job"]',
          el => el.textContent.trim()
        ).catch(() => null);
        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[class*="company"], [class*="companyName"], [class*="employer"]',
          el => el.textContent.trim()
        ).catch(() => 'Unknown');

        const jobUrl = await card.$eval(
          'a[href*="foundit.in"], a[href*="/job/"], a[href*="monster"], a',
          el => el.href
        ).catch(() => null);
        if (!jobUrl) continue;

        const fullUrl = jobUrl.startsWith('http') ? jobUrl : `https://www.foundit.in${jobUrl}`;
        jobs.push({ title, company, location, url: fullUrl, description: `${title} at ${company} in ${location}. Apply on Foundit.` });
      } catch (_) {}
    }

    if (jobs.length === 0) {
      console.log('Foundit: trying link fallback');
      const links = await page.$$('a[href*="/job/"], a[href*="foundit.in/srp"]');
      console.log(`Foundit: found ${links.length} job links`);
      for (const link of links) {
        if (jobs.length >= maxJobs) break;
        try {
          const text = (await link.textContent() || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.foundit.in${href}`;
          jobs.push({ title: text, company: 'See listing', location, url: jobUrl, description: `${text} - Apply on Foundit.` });
        } catch (_) {}
      }
    }

    console.log(`Foundit: returning ${jobs.length} jobs`);
  } catch (err) { console.error(`Foundit error:`, err.message); }
  return jobs;
}

// Company Career Pages - FIXED: filter was matching login/register/about pages
// because it accepted ANY link containing "career" in the href. Now requires
// real job-title-shaped text AND excludes known non-job paths (login, register,
// signin, sign-up, about, contact, faq, privacy, terms, help, support).
const COMPANY_CAREERS = [
  { name: 'Infosys',   url: 'https://career.infosys.com/joblist',       origin: 'https://career.infosys.com' },
  { name: 'Wipro',     url: 'https://careers.wipro.com/careers-home/',   origin: 'https://careers.wipro.com' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global/en',   origin: 'https://careers.cognizant.com' },
];

const NON_JOB_PATH_PATTERNS = [
  'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register',
  'account', 'profile', 'about', 'contact', 'faq', 'privacy', 'terms',
  'help', 'support', 'cookie', 'feedback', 'unsubscribe', 'home', 'index'
];

// A real job title is usually 3+ words and contains a role-shaped word.
// This is stricter than the old check, which matched on the URL alone.
function looksLikeJobTitle(text) {
  const t = text.trim();
  if (t.length < 8) return false;
  const wordCount = t.split(/\s+/).length;
  if (wordCount < 2) return false;
  const roleWords = ['engineer', 'developer', 'software', 'analyst', 'architect',
    'consultant', 'manager', 'specialist', 'lead', 'intern', 'associate',
    'designer', 'administrator', 'scientist', 'tester', 'qa', 'devops'];
  const tl = t.toLowerCase();
  return roleWords.some(w => tl.includes(w));
}

function isNonJobPath(href) {
  const h = href.toLowerCase();
  return NON_JOB_PATH_PATTERNS.some(p => h.includes(p));
}

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
      for (const link of links.slice(0, 150)) {
        try {
          const text = (await link.textContent() || '').trim();
          const rawHref = await link.getAttribute('href');
          if (!rawHref) continue;
          const hrefLower = rawHref.toLowerCase();

          // Reject obvious non-job pages first, regardless of text match
          if (isNonJobPath(hrefLower)) continue;

          // Require the link TEXT to actually look like a job title,
          // not just the URL containing "career" or "job"
          if (!looksLikeJobTitle(text) || shouldExclude(text, excludeKeywords)) continue;

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

// Routes
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/linkedin-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 3, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await newLinkedInContext(browser)).newPage();
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
  const body = req.body;
  const jobUrl = body.jobUrl;
  const platform = body.platform;
  const jobTitle = body.jobTitle;
  const company = body.company;

  const candidate = body.candidate || {
    email: body.candidateEmail || body.email || '',
    fullName: body.candidateFullName || body.fullName || '',
    phone: body.candidatePhone || body.phone || '',
    skills: body.candidateSkills || body.skills || '',
    resumeText: body.candidateResumeText || body.resumeText || '',
    coverLetter: body.candidateCoverLetter || body.coverLetter || ''
  };

  console.log(`Auto Apply: url=${jobUrl}, platform=${platform}, email=${candidate.email}`);
  let browser;
  if (!jobUrl || !candidate.email) {
    return res.status(400).json({ error: 'jobUrl and candidate email required', received: { jobUrl, email: candidate.email } });
  }

  // Reject known non-job URLs outright, before even launching a browser.
  // This is the same filter used in scrapeCompanyJobs, applied defensively
  // here too in case a bad URL slips through from any source.
  if (isNonJobPath(jobUrl)) {
    console.log(`Auto Apply: rejected - URL looks like a login/register/info page, not a job: ${jobUrl}`);
    return res.json({
      success: false,
      message: 'URL does not appear to be a real job posting (login/register/info page)',
      platform, jobUrl, appliedAt: new Date().toISOString()
    });
  }

  try {
    browser = await launchBrowser();
    if (platform === 'linkedin') {
      // LinkedIn auto-apply gets extra randomized pacing. Rapid, evenly-spaced
      // automated actions are a strong bot signal - a random 8-20s pause before
      // even opening the page makes the pattern look more human and reduces
      // how quickly the session gets flagged/invalidated.
      const humanDelay = 8000 + Math.floor(Math.random() * 12000);
      console.log(`Auto Apply (LinkedIn): pacing - waiting ${Math.round(humanDelay / 1000)}s before starting`);
      await sleep(humanDelay);
    }
    const context = platform === 'linkedin' ? await newLinkedInContext(browser) : await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' });
    const page = await context.newPage();
    let result;
    if (platform === 'linkedin') result = await applyLinkedIn(page, jobUrl, candidate);
    else if (platform === 'indeed') result = await applyIndeed(page, jobUrl, candidate);
    else result = await applyGeneric(page, jobUrl, candidate);
    await browser.close();

    if (!result || result.submitted !== true) {
      // No real submission happened - report honestly instead of a blind success
      return res.json({
        success: false,
        message: (result && result.reason) || 'No application form/submit action found on page',
        platform, jobUrl, appliedAt: new Date().toISOString()
      });
    }
    res.json({ success: true, message: `Applied to ${jobTitle} at ${company}`, platform, jobUrl, appliedAt: new Date().toISOString() });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.json({ success: false, message: err.message, platform, jobUrl, appliedAt: new Date().toISOString() });
  }
});

async function applyLinkedIn(page, jobUrl, candidate) {
  if (!process.env.LINKEDIN_SESSION_STATE) {
    return { submitted: false, reason: 'No LinkedIn session configured (LINKEDIN_SESSION_STATE not set) - cannot apply while logged out' };
  }
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanPause();

  // Detect a logged-out/sign-in wall explicitly, so the failure reason is
  // accurate instead of just "no apply button found".
  const signInWall = await page.$('a[href*="/login"], button:has-text("Sign in"), .authwall, [data-tracking-control-name*="authwall"]');
  if (signInWall) {
    return { submitted: false, reason: 'LinkedIn session appears logged out or expired - hit a sign-in wall' };
  }

  const btn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]');
  if (!btn) return { submitted: false, reason: 'No Easy Apply button found' };
  await btn.click(); await humanPause();
  await fillField(page, 'input[name="phoneNumber"], input[id*="phone"]', candidate.phone || '');
  await humanPause(800, 1800);
  await fillField(page, 'input[id*="email"]', candidate.email);
  await humanPause(800, 1800);
  let submitted = false;
  for (let i = 0; i < 5; i++) {
    const submit = await page.$('button[aria-label="Submit application"]');
    if (submit) { await submit.click(); await humanPause(); submitted = true; break; }
    const next = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (next) { await next.click(); await humanPause(1200, 2500); } else break;
  }
  return { submitted, reason: submitted ? null : 'Could not reach final submit step' };
}

async function applyIndeed(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const btn = await page.$('button[id*="apply"], a[id*="apply"], button[class*="apply"]');
  if (!btn) return { submitted: false, reason: 'No apply button found' };
  await btn.click(); await sleep(2000);
  await fillField(page, 'input[name="email"], input[type="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[id*="name"]', candidate.fullName || '');
  const submit = await page.$('button[type="submit"], button[id*="submit"]');
  if (!submit) return { submitted: false, reason: 'No submit button found after clicking apply' };
  await submit.click();
  return { submitted: true, reason: null };
}

// FIXED: previously this always returned success because it never threw,
// even if it never found an apply button. Now it tracks whether an apply
// button AND a submit action both actually happened, and reports that.
async function applyGeneric(page, jobUrl, candidate) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  let clickedApply = false;
  for (const sel of ['a[href*="apply"]', 'button:has-text("Apply")', 'a:has-text("Apply Now")', '[class*="apply"]', '[id*="apply"]']) {
    try { await page.click(sel, { timeout: 3000 }); await sleep(2000); clickedApply = true; break; } catch (_) {}
  }

  if (!clickedApply) {
    return { submitted: false, reason: 'No apply button/link found on page - likely not a real job posting' };
  }

  const emailField = await page.$('input[type="email"], input[name="email"]');
  if (!emailField) {
    return { submitted: false, reason: 'No application form appeared after clicking apply' };
  }
  await fillField(page, 'input[type="email"], input[name="email"]', candidate.email);
  await fillField(page, 'input[name="name"], input[name="fullName"], input[id*="name"]', candidate.fullName || '');
  if (candidate.coverLetter) await fillField(page, 'textarea[name*="cover"], textarea[id*="cover"]', candidate.coverLetter);

  // If the form has a file input for the resume, generate a simple PDF from
  // the candidate's resume text and upload it. This is a best-effort fallback,
  // not a substitute for the user's original formatted resume.
  let resumePdfPath = null;
  try {
    const fileInput = await page.$('input[type="file"][name*="resume" i], input[type="file"][id*="resume" i], input[type="file"][name*="cv" i], input[type="file"]');
    if (fileInput) {
      resumePdfPath = await generateResumePdf(candidate);
      if (resumePdfPath) {
        await fileInput.setInputFiles(resumePdfPath);
        await sleep(1000);
        console.log('Resume PDF: uploaded to file input on form');
      } else {
        console.log('Resume PDF: form has a file input but no resumeText was available to generate one');
      }
    }
  } catch (err) {
    console.error('Resume PDF: upload attempt failed:', err.message);
  }

  const submitBtn = await page.$('button[type="submit"], input[type="submit"], button[id*="submit"], button:has-text("Submit")');
  if (!submitBtn) {
    cleanupResumePdf(resumePdfPath);
    return { submitted: false, reason: 'Form filled but no submit button found' };
  }
  try {
    await submitBtn.click();
    await sleep(2000);
    cleanupResumePdf(resumePdfPath);
    return { submitted: true, reason: null };
  } catch (e) {
    cleanupResumePdf(resumePdfPath);
    return { submitted: false, reason: `Submit click failed: ${e.message}` };
  }
}

async function fillField(page, selector, value) {
  if (!value) return;
  try { const el = await page.$(selector); if (el) await el.fill(value); } catch (_) {}
}

app.listen(PORT, () => {
  console.log(`Job scraper server running on port ${PORT}`);
  console.log('Endpoints: POST /linkedin-jobs | POST /indeed-jobs | POST /google-jobs | POST /company-jobs | POST /auto-apply | GET /health');
});
