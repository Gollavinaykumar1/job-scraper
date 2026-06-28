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
      '--single-process', '--disable-gpu'
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
    const key = (j.url || '') + '|' + (j.title || '') + '|' + (j.company || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Cleans up salary text - removes extra whitespace and normalises
function cleanSalary(text) {
  if (!text) return 'Not disclosed';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Filter out non-salary strings that sometimes bleed in
  if (cleaned.length < 3 || cleaned.length > 80) return 'Not disclosed';
  if (/salary|lpa|lakh|per annum|₹|inr|ctc|pa|month|year/i.test(cleaned)) return cleaned;
  return 'Not disclosed';
}

// Simple ATS scorer - compares resume skills against job description
// Returns 0-100 score based on keyword overlap
function calculateATS(resumeSkills, resumeExperience, jobTitle, jobDescription) {
  if (!resumeSkills && !resumeExperience) return null; // no resume data

  const resumeText = ((resumeSkills || '') + ' ' + (resumeExperience || '')).toLowerCase();
  const jobText = ((jobTitle || '') + ' ' + (jobDescription || '')).toLowerCase();

  // Extract meaningful words from job description (ignore stopwords)
  const stopwords = new Set(['the','a','an','and','or','but','in','on','at','to','for',
    'of','with','by','from','as','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','may',
    'might','shall','can','need','must','our','your','their','we','you','they',
    'it','this','that','these','those','who','which','what','where','when','how',
    'all','any','both','each','few','more','most','other','some','such','than',
    'too','very','just','about','above','after','before','between','into','through',
    'during','including','work','working','experience','good','strong','excellent',
    'ability','skills','knowledge','understanding','team','company','looking','role',
    'position','join','opportunity','candidate','required','requirements','responsibilities',
    'apply','job','hiring','recruit','description','qualification','preferred','plus','years']);

  const jobWords = jobText.split(/\W+/).filter(w => w.length > 2 && !stopwords.has(w));
  const uniqueJobWords = [...new Set(jobWords)];

  // Tech/role specific terms get double weight
  const techTerms = ['python','java','javascript','typescript','react','node','nodejs',
    'angular','vue','sql','mysql','postgresql','mongodb','redis','aws','azure','gcp',
    'docker','kubernetes','git','linux','api','rest','graphql','microservices','agile',
    'scrum','spring','django','flask','express','html','css','devops','ci/cd','jenkins',
    'terraform','ansible','kafka','spark','hadoop','machine learning','deep learning',
    'tensorflow','pytorch','nlp','data science','data engineering','etl','tableau',
    'powerbi','excel','c++','c#','.net','php','ruby','golang','rust','swift','kotlin',
    'android','ios','flutter','react native','selenium','cypress','junit','jest'];

  let matched = 0;
  let total = 0;

  for (const word of uniqueJobWords) {
    if (techTerms.includes(word)) {
      total += 2;
      if (resumeText.includes(word)) matched += 2;
    } else {
      total += 1;
      if (resumeText.includes(word)) matched += 1;
    }
  }

  if (total === 0) return 60; // default mid-score if no extractable keywords
  const raw = Math.round((matched / total) * 100);
  // Clamp between 20-95 (no perfect scores, no zero scores for real jobs)
  return Math.min(95, Math.max(20, raw));
}

// ─── LINKEDIN ─────────────────────────────────────────────────────────────────

function getLinkedInStorageState() {
  const raw = process.env.LINKEDIN_SESSION_STATE;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function newLinkedInContext(browser) {
  const storageState = getLinkedInStorageState();
  const opts = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
  };
  if (storageState) opts.storageState = storageState;
  return await browser.newContext(opts);
}

// Scrapes the actual job detail page to get real description
async function fetchLinkedInJobDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);

    const description = await page.$eval(
      '.show-more-less-html__markup, .description__text, [class*="description"] .show-more-less-html',
      el => el.innerText.trim()
    ).catch(() => null);

    const salary = await page.$eval(
      '.compensation__salary, [class*="salary"], .salary-range, .compensation-range',
      el => el.innerText.trim()
    ).catch(() => null);

    const experienceLevel = await page.$eval(
      '.description__job-criteria-text',
      el => el.innerText.trim()
    ).catch(() => null);

    return {
      description: description || null,
      salary: cleanSalary(salary),
      experienceLevel: experienceLevel || 'Entry level'
    };
  } catch (err) {
    console.error(`LinkedIn detail fetch error: ${err.message}`);
    return { description: null, salary: 'Not disclosed', experienceLevel: 'Entry level' };
  }
}

async function scrapeLinkedIn(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    // f_E=2%2C3 = Entry level + Associate; f_TPR=r86400 = last 24h; sortBy=DD = most recent
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}&f_TPR=r604800&f_E=2%2C3&sortBy=DD`;
    console.log(`LinkedIn: loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Accept cookies if prompted
    try { await page.click('button[action-type="ACCEPT"]', { timeout: 3000 }); await sleep(500); } catch (_) {}

    // Scroll to load more cards
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(800);
    }

    await page.waitForSelector('.job-card-container, .base-card', { timeout: 15000 }).catch(() => {});

    const cards = await page.$$('.job-card-container, .base-card');
    console.log(`LinkedIn: found ${cards.length} cards for "${role}" in "${location}"`);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '.job-card-list__title, .base-search-card__title, [class*="job-card-list__title"]',
          el => el.innerText.trim()
        ).catch(() => null);

        if (!title || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '.job-card-container__primary-description, .base-search-card__subtitle, [class*="primary-description"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown Company');

        const locationText = await card.$eval(
          '.job-card-container__metadata-item, .job-search-card__location, [class*="metadata-item"]',
          el => el.innerText.trim()
        ).catch(() => location);

        const jobUrl = await card.$eval(
          'a.job-card-list__title, a.base-card__full-link, a[class*="base-card__full-link"]',
          el => el.href
        ).catch(() => null);

        if (!jobUrl) continue;

        // Get salary from card if available
        const salaryFromCard = await card.$eval(
          '.job-card-container__salary-info, [class*="salary"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const postedDate = await card.$eval(
          'time, .job-card-container__listdate, [class*="listdate"]',
          el => el.getAttribute('datetime') || el.innerText.trim()
        ).catch(() => new Date().toISOString());

        jobs.push({
          title,
          company,
          location: locationText,
          url: jobUrl,
          salary: cleanSalary(salaryFromCard),
          postedDate,
          source: 'LinkedIn',
          description: null, // fetched separately below
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }

    // Fetch real descriptions for each job (up to maxJobs)
    console.log(`LinkedIn: fetching details for ${jobs.length} jobs...`);
    for (const job of jobs) {
      try {
        const detail = await fetchLinkedInJobDetail(page, job.url);
        if (detail.description) job.description = detail.description.substring(0, 1500);
        if (detail.salary !== 'Not disclosed') job.salary = detail.salary;
        job.experienceLevel = detail.experienceLevel;
        await sleep(1000);
      } catch (_) {}
    }

  } catch (err) {
    console.error(`LinkedIn scrape error: ${err.message}`);
  }
  return jobs;
}

// ─── NAUKRI (replaces Shine/Indeed) ───────────────────────────────────────────
// Naukri.com is India's largest job portal and DOES show real salary, 
// experience, and company data in listing cards - far better than Shine.

async function scrapeNaukri(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const roleSlug = encodeURIComponent(role);
    const locSlug = encodeURIComponent(location);
    // experienceRange=0 means fresher/entry level
    const url = `https://www.naukri.com/${role.toLowerCase().replace(/\s+/g,'-')}-jobs-in-${location.toLowerCase().replace(/\s+/g,'-')}?experience=0&jobAge=7`;
    console.log(`Naukri: loading "${role}" in "${location}"`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Scroll to trigger lazy loading
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await sleep(600);
    }

    await page.waitForSelector('[class*="jobTuple"], article.jobTuple, .cust-job-tuple', { timeout: 10000 }).catch(() => {});

    let cards = [];
    for (const sel of [
      'article.jobTuple', '[class*="jobTuple"]', '.cust-job-tuple',
      '[class*="job-tuple"]', '[class*="srp-jobtuple"]', '.list article'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Naukri: using "${sel}", found ${cards.length} cards`); break; }
    }

    console.log(`Naukri: total cards found = ${cards.length}`);

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          'a.title, [class*="title"] a, h2 a, .jobTitle a, a[class*="title"]',
          el => el.innerText.trim()
        ).catch(() => null);

        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          'a.subTitle, [class*="subTitle"], [class*="companyInfo"] a, .comp-name, [class*="comp-name"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        // Naukri shows real salary in cards - grab it
        const salary = await card.$eval(
          '[class*="salary"], .salary, [class*="sal"], li.salary',
          el => el.innerText.trim()
        ).catch(() => null);

        // Naukri shows real experience requirement
        const experience = await card.$eval(
          '[class*="experience"], .experience, li.experience, [class*="exp"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const locationText = await card.$eval(
          '[class*="location"], .location, li.location, [class*="loc"]',
          el => el.innerText.trim()
        ).catch(() => location);

        // Real job description snippet
        const description = await card.$eval(
          '[class*="job-description"], [class*="jobDesc"], .job-desc, [class*="description"]',
          el => el.innerText.trim()
        ).catch(() => null);

        // Skills listed on card
        const skills = await card.$eval(
          '[class*="tags"], [class*="skills"], ul.tags-gt li',
          el => el.innerText.replace(/\n/g, ', ').trim()
        ).catch(() => null);

        const jobUrl = await card.$eval(
          'a.title, a[class*="title"], h2 a',
          el => el.href
        ).catch(() => null);

        if (!jobUrl) continue;

        const postedDate = await card.$eval(
          '[class*="postedDate"], .postedDate, time',
          el => el.innerText.trim()
        ).catch(() => '');

        jobs.push({
          title,
          company,
          location: locationText.replace(/\n/g, ', ').trim(),
          url: jobUrl.startsWith('http') ? jobUrl : `https://www.naukri.com${jobUrl}`,
          salary: cleanSalary(salary),
          experience: experience || '0-2 Years',
          description: description
            ? (skills ? `${description}\n\nSkills: ${skills}` : description).substring(0, 1500)
            : (skills ? `Skills required: ${skills}` : `${title} at ${company}`),
          postedDate,
          source: 'Naukri',
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }

    // Fallback: try link-based approach
    if (jobs.length === 0) {
      console.log('Naukri: primary selector failed, trying link fallback');
      const links = await page.$$('a[href*="naukri.com"][href*="-jobs-"]');
      console.log(`Naukri: found ${links.length} job links in fallback`);
      for (const link of links.slice(0, maxJobs * 2)) {
        if (jobs.length >= maxJobs) break;
        try {
          const text = (await link.innerText() || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          jobs.push({
            title: text,
            company: 'See job link',
            location,
            url: href.startsWith('http') ? href : `https://www.naukri.com${href}`,
            salary: 'Not disclosed',
            experience: '0-2 Years',
            description: `${text} - Apply on Naukri.com`,
            postedDate: '',
            source: 'Naukri',
            experienceLevel: 'Entry level'
          });
        } catch (_) {}
      }
    }

    console.log(`Naukri: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Naukri error: ${err.message}`);
  }
  return jobs;
}

// ─── FOUNDIT (formerly Monster India) ────────────────────────────────────────
// Restored with better selectors that actually work on current Foundit layout

async function scrapeFoundit(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  try {
    const query = encodeURIComponent(role);
    const loc = encodeURIComponent(location);
    const url = `https://www.foundit.in/srp/results?query=${query}&location=${loc}&experienceRanges=0~3&jobAge=7`;
    console.log(`Foundit: loading "${role}" in "${location}"`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(700);
    }

    await page.waitForSelector('[class*="card"], [class*="job-card"], [class*="srp-"]', { timeout: 10000 }).catch(() => {});

    let cards = [];
    for (const sel of [
      '[class*="cardContainer"]', '[class*="jobCard"]', '[class*="card-container"]',
      '.srp-jobtuple', '[class*="resultItem"]', '[data-job-id]',
      'article[class*="job"]', '[class*="jobItem"]'
    ]) {
      cards = await page.$$(sel);
      if (cards.length > 0) { console.log(`Foundit: using "${sel}", found ${cards.length} cards`); break; }
    }

    for (const card of cards) {
      if (jobs.length >= maxJobs) break;
      try {
        const title = await card.$eval(
          '[class*="title"], [class*="jobTitle"], h3, h2, a[class*="job"]',
          el => el.innerText.trim()
        ).catch(() => null);

        if (!title || title.length < 3 || shouldExclude(title, excludeKeywords)) continue;

        const company = await card.$eval(
          '[class*="company"], [class*="companyName"], [class*="employer"]',
          el => el.innerText.trim()
        ).catch(() => 'Unknown');

        const salary = await card.$eval(
          '[class*="salary"], [class*="sal"], [class*="ctc"], [class*="package"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const experience = await card.$eval(
          '[class*="experience"], [class*="exp"], [class*="year"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const locationText = await card.$eval(
          '[class*="location"], [class*="loc"]',
          el => el.innerText.trim()
        ).catch(() => location);

        const description = await card.$eval(
          '[class*="description"], [class*="desc"], [class*="snippet"]',
          el => el.innerText.trim()
        ).catch(() => null);

        const jobUrl = await card.$eval(
          'a[href*="foundit"], a[href*="/job/"], a',
          el => el.href
        ).catch(() => null);

        if (!jobUrl) continue;

        const postedDate = await card.$eval(
          '[class*="date"], [class*="posted"], time',
          el => el.innerText.trim()
        ).catch(() => '');

        jobs.push({
          title,
          company,
          location: locationText,
          url: jobUrl.startsWith('http') ? jobUrl : `https://www.foundit.in${jobUrl}`,
          salary: cleanSalary(salary),
          experience: experience || '0-2 Years',
          description: description ? description.substring(0, 1500) : `${title} at ${company} in ${locationText}`,
          postedDate,
          source: 'Foundit',
          experienceLevel: 'Entry level'
        });
      } catch (_) {}
    }

    // Link fallback
    if (jobs.length === 0) {
      const links = await page.$$('a[href*="/job/"], a[href*="foundit.in"]');
      for (const link of links.slice(0, maxJobs * 2)) {
        if (jobs.length >= maxJobs) break;
        try {
          const text = (await link.innerText() || '').trim();
          if (text.length < 5 || shouldExclude(text, excludeKeywords)) continue;
          const href = await link.getAttribute('href');
          if (!href || href === '#') continue;
          const jobUrl = href.startsWith('http') ? href : `https://www.foundit.in${href}`;
          const companyName = await link.evaluate(el => {
            const card = el.closest('[class*="card" i], article');
            const c = card?.querySelector('[class*="company" i], [class*="employer" i]');
            return c ? c.innerText.trim() : null;
          }).catch(() => null);
          jobs.push({
            title: text, company: companyName || 'See job link', location,
            url: jobUrl, salary: 'Not disclosed', experience: '0-2 Years',
            description: `${text} - Apply on Foundit`, postedDate: '',
            source: 'Foundit', experienceLevel: 'Entry level'
          });
        } catch (_) {}
      }
    }

    console.log(`Foundit: returning ${jobs.length} jobs`);
  } catch (err) {
    console.error(`Foundit error: ${err.message}`);
  }
  return jobs;
}

// ─── COMPANY CAREER PAGES ─────────────────────────────────────────────────────

const COMPANY_CAREERS = [
  { name: 'Infosys',    url: 'https://career.infosys.com/joblist',      origin: 'https://career.infosys.com' },
  { name: 'Wipro',      url: 'https://careers.wipro.com/careers-home/', origin: 'https://careers.wipro.com' },
  { name: 'Cognizant',  url: 'https://careers.cognizant.com/global/en', origin: 'https://careers.cognizant.com' },
  { name: 'TCS',        url: 'https://www.tcs.com/careers/tcs-careers-jobdetails', origin: 'https://www.tcs.com' },
  { name: 'HCL',        url: 'https://www.hcltech.com/careers',         origin: 'https://www.hcltech.com' },
];

const NON_JOB_PATH_PATTERNS = [
  'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register',
  'account', 'profile', 'about', 'contact', 'faq', 'privacy', 'terms',
  'help', 'support', 'cookie', 'feedback', 'unsubscribe', 'home', 'index'
];

function isNonJobPath(href) {
  const h = href.toLowerCase();
  return NON_JOB_PATH_PATTERNS.some(p => h.includes(p));
}

function looksLikeJobTitle(text) {
  const t = text.trim();
  if (t.length < 8 || t.split(/\s+/).length < 2) return false;
  const roleWords = ['engineer', 'developer', 'software', 'analyst', 'architect',
    'consultant', 'specialist', 'associate', 'designer', 'administrator',
    'scientist', 'tester', 'qa', 'devops', 'intern', 'trainee', 'fresher',
    'graduate', 'technology', 'technical', 'programmer', 'full stack', 'backend',
    'frontend', 'data', 'cloud', 'support', 'network'];
  const tl = t.toLowerCase();
  return roleWords.some(w => tl.includes(w));
}

async function scrapeCompanyJobs(page, role, location, maxJobs, excludeKeywords) {
  const jobs = [];
  for (const company of COMPANY_CAREERS) {
    const companyJobs = [];
    try {
      await page.goto(company.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);

      // Try to search for the role
      try {
        const searchBox = await page.$(
          'input[type="search"], input[placeholder*="search" i], input[name*="keyword" i], input[placeholder*="job" i], input[placeholder*="role" i]'
        );
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
          const text = (await link.innerText() || '').trim();
          const rawHref = await link.getAttribute('href');
          if (!rawHref || isNonJobPath(rawHref)) continue;
          if (!looksLikeJobTitle(text) || shouldExclude(text, excludeKeywords)) continue;

          const jobUrl = rawHref.startsWith('http')
            ? rawHref
            : `${company.origin}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;

          companyJobs.push({
            title: text,
            company: company.name,
            location,
            url: jobUrl,
            salary: 'As per industry standards',
            experience: '0-2 Years (Fresher/Entry level)',
            description: `${text} at ${company.name}. Entry level opportunity.`,
            postedDate: new Date().toISOString().split('T')[0],
            source: `${company.name} Careers`,
            experienceLevel: 'Entry level'
          });
        } catch (_) {}
      }
      console.log(`Company: ${company.name} → ${companyJobs.length} jobs`);
    } catch (err) {
      console.error(`Company error [${company.name}]: ${err.message}`);
    }
    jobs.push(...companyJobs);
  }
  return jobs;
}

// ─── ATS SCORING ENDPOINT ─────────────────────────────────────────────────────

app.post('/ats-score', (req, res) => {
  const { resumeSkills, resumeExperience, jobs } = req.body;
  if (!jobs || !Array.isArray(jobs)) {
    return res.status(400).json({ error: 'jobs array required' });
  }
  const scored = jobs.map(job => ({
    ...job,
    atsScore: calculateATS(resumeSkills, resumeExperience, job.title, job.description)
  }));
  // Sort by ATS score descending
  scored.sort((a, b) => (b.atsScore || 0) - (a.atsScore || 0));
  res.json(scored);
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/linkedin-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const context = await newLinkedInContext(browser);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`LinkedIn: scraping "${search.role}" in "${location}"`);
        const jobs = await scrapeLinkedIn(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []);
        allJobs.push(...jobs);
        await sleep(1500);
      }
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`LinkedIn: total returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Naukri endpoint (replaces the old /indeed-jobs which scraped Shine)
app.post('/indeed-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })).newPage();

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Naukri: scraping "${search.role}" in "${location}"`);
        allJobs.push(...await scrapeNaukri(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
        await sleep(2000);
      }
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Naukri: total returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Foundit endpoint (replaces old /google-jobs)
app.post('/google-jobs', async (req, res) => {
  const { searches = [], maxJobsPerSearch = 5, filters = {} } = req.body;
  let allJobs = [], browser;
  try {
    browser = await launchBrowser();
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })).newPage();

    for (const search of searches) {
      for (const location of (search.locations || [])) {
        console.log(`Foundit: scraping "${search.role}" in "${location}"`);
        allJobs.push(...await scrapeFoundit(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
        await sleep(2000);
      }
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Foundit: total returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

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
      console.log(`Company: scraping "${search.role}" in "${location}"`);
      allJobs.push(...await scrapeCompanyJobs(page, search.role, location, maxJobsPerSearch, filters.excludeKeywords || []));
      await sleep(1000);
    }

    await browser.close();
    allJobs = deduplicateJobs(allJobs);
    console.log(`Company: total returning ${allJobs.length} jobs`);
    res.json(allJobs);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Job scraper server running on port ${PORT}`);
  console.log('Endpoints: GET /health | POST /linkedin-jobs | POST /indeed-jobs | POST /google-jobs | POST /company-jobs | POST /ats-score');
});
