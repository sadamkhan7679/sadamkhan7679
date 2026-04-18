const https = require('https');
const fs = require('fs');

// Config
const USERNAME = process.env.GITHUB_USERNAME || 'sadamkhan7679';
const TOKEN = process.env.GITHUB_TOKEN;
const BASE = 'https://api.github.com';

const NOW = new Date();
const D30 = new Date(NOW - 30 * 86400000);
const D90 = new Date(NOW - 90 * 86400000);

// Promisified HTTPS GET with auth
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'profile-insights-bot',
      },
    };

    https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(
            `GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`
          ));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Pagination helper
async function fetchAllPages(path, maxPages = 100) {
  const results = [];
  let url = path;
  let pageCount = 0;

  while (url && pageCount < maxPages) {
    const response = await apiGet(url);

    if (Array.isArray(response)) {
      results.push(...response);
    } else {
      results.push(response);
    }

    // Parse Link header for next page
    const linkHeader = response._headers?.link || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    pageCount++;
  }

  return results;
}

// Data fetchers
async function fetchRepos() {
  let allRepos = [];
  let page = 1;
  const maxPages = 10; // Support up to 1000 repos

  while (page <= maxPages) {
    const repos = await apiGet(
      `/users/${USERNAME}/repos?per_page=100&sort=pushed&type=public&direction=desc&page=${page}`
    );

    if (!Array.isArray(repos) || repos.length === 0) break;
    allRepos.push(...repos);
    page++;
  }

  return allRepos;
}

async function fetchEvents() {
  let allEvents = [];
  let page = 1;
  const maxPages = 3;

  while (page <= maxPages) {
    const events = await apiGet(
      `/users/${USERNAME}/events/public?per_page=100&page=${page}`
    );

    if (!Array.isArray(events) || events.length === 0) break;
    allEvents.push(...events);
    page++;
  }

  return allEvents;
}

async function fetchUser() {
  return apiGet(`/users/${USERNAME}`);
}

// Compute insights from raw data
function computeInsights(repos, events) {
  // Filter public, non-archived repos
  const activeRepos = repos.filter((r) => !r.archived);

  // Top repositories by momentum
  const topRepos = activeRepos
    .map((repo) => {
      const lastPush = new Date(repo.pushed_at);
      const daysAgo = Math.floor((NOW - lastPush) / 86400000);

      let recency = 0;
      if (daysAgo < 7) recency = 40;
      else if (daysAgo < 30) recency = 20;
      else if (daysAgo < 90) recency = 10;

      const score =
        repo.stargazers_count * 3 +
        repo.forks_count * 2 +
        recency;

      return {
        name: repo.name,
        url: repo.html_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        pushedAt: lastPush,
        daysAgo,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Engineering activity snapshot
  const activity = {
    commits30: 0,
    commits90: 0,
    prs30: 0,
    prs90: 0,
    issues30: 0,
    issues90: 0,
  };

  events.forEach((event) => {
    const createdAt = new Date(event.created_at);

    if (event.type === 'PushEvent') {
      if (createdAt >= D30) activity.commits30 += event.payload?.size || 1;
      if (createdAt >= D90) activity.commits90 += event.payload?.size || 1;
    } else if (event.type === 'PullRequestEvent') {
      if (event.payload?.action === 'opened') {
        if (createdAt >= D30) activity.prs30++;
        if (createdAt >= D90) activity.prs90++;
      }
    } else if (event.type === 'IssuesEvent') {
      if (event.payload?.action === 'opened') {
        if (createdAt >= D30) activity.issues30++;
        if (createdAt >= D90) activity.issues90++;
      }
    }
  });

  // Open source health
  const totalStars = activeRepos.reduce((sum, r) => sum + r.stargazers_count, 0);
  const totalForks = activeRepos.reduce((sum, r) => sum + r.forks_count, 0);
  const avgForks = activeRepos.length > 0 ? (totalForks / activeRepos.length).toFixed(2) : '0.00';

  const mostStarred = activeRepos.reduce((max, r) =>
    r.stargazers_count > (max?.stargazers_count || 0) ? r : max, null);

  // Tech footprint
  const langMap = {};
  activeRepos.forEach((repo) => {
    if (repo.language) {
      langMap[repo.language] = (langMap[repo.language] || 0) + 1;
    }
  });

  const totalWithLang = Object.values(langMap).reduce((sum, count) => sum + count, 0);
  const techFootprint = Object.entries(langMap)
    .map(([lang, count]) => ({
      language: lang,
      repoCount: count,
      percent: totalWithLang > 0 ? ((count / totalWithLang) * 100).toFixed(1) : '0.0',
    }))
    .sort((a, b) => b.repoCount - a.repoCount)
    .slice(0, 8);

  return {
    topRepos,
    activity,
    health: {
      publicRepos: activeRepos.length,
      totalStars,
      totalForks,
      avgForks,
      mostStarred,
    },
    techFootprint,
    generatedAt: NOW.toISOString().split('T')[0],
  };
}

// Render markdown
function renderMarkdown(insights) {
  const { topRepos, activity, health, techFootprint, generatedAt } = insights;

  let md = '\n\n---\n\n';
  md += '## ⚡ GitHub Insights\n\n';
  md += `> Auto-refreshed daily · Last updated: ${generatedAt} UTC\n\n`;
  md += '---\n\n';

  // Top repositories by momentum
  md += '### 🚀 Top Repositories by Momentum\n\n';
  md += '| Repository | Stars | Forks | Last Push | Status |\n';
  md += '|:---|---:|---:|:---|:---|\n';
  topRepos.forEach((repo) => {
    const daysText = repo.daysAgo === 0 ? 'today' : `${repo.daysAgo}d ago`;
    let statusLabel = '💤 Quiet';
    if (repo.score >= 60) statusLabel = '🔥 High';
    else if (repo.score >= 30) statusLabel = '📈 Active';

    md += `| [${repo.name}](${repo.url}) | ⭐ ${repo.stars} | 🍴 ${repo.forks} | ${daysText} | ${statusLabel} |\n`;
  });

  // Activity snapshot
  md += '\n---\n\n';
  md += '### 📊 Engineering Activity Snapshot\n\n';
  md += '| Window | Commits | Pull Requests | Issues Opened |\n';
  md += '|:---|---:|---:|---:|\n';
  md += `| 🗓️ Last 30 days | ${activity.commits30} | ${activity.prs30} | ${activity.issues30} |\n`;
  md += `| 🗓️ Last 90 days | ${activity.commits90} | ${activity.prs90} | ${activity.issues90} |\n`;
  md += '\n> _Computed from GitHub Public Events API (covers up to ~300 recent events)_\n';

  // Open source health
  md += '\n---\n\n';
  md += '### 🏥 Open Source Health\n\n';
  md += '| Metric | Value |\n';
  md += '|:---|:---|\n';
  md += `| Public Repositories | ${health.publicRepos} |\n`;
  md += `| Total Stars | ⭐ ${health.totalStars} |\n`;
  md += `| Total Forks | 🍴 ${health.totalForks} |\n`;
  md += `| Avg Forks per Repo | ${health.avgForks} |\n`;
  if (health.mostStarred) {
    md += `| Most Starred | [${health.mostStarred.name}](${health.mostStarred.html_url}) ⭐ ${health.mostStarred.stargazers_count} |\n`;
  }

  // Tech footprint
  md += '\n---\n\n';
  md += '### 🧠 Tech Footprint\n\n';
  md += '| Language | Repos | Share |\n';
  md += '|:---|---:|---:|\n';
  techFootprint.forEach((tech) => {
    md += `| ${tech.language} | ${tech.repoCount} | ${tech.percent}% |\n`;
  });

  md += '\n---\n\n';
  md += '<div align="center">\n';
  md += '<sub>Generated by <a href=".github/workflows/profile-insights.yml">profile-insights workflow</a></sub>\n';
  md += '</div>\n';

  return md;
}

// Insert content between markers
function insertMarkers(newContent) {
  const START = '<!-- INSIGHTS:START -->';
  const END = '<!-- INSIGHTS:END -->';

  const readme = fs.readFileSync('README.md', 'utf8');

  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Markers not found in README.md — cannot safely write');
  }

  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);

  const updated = before + newContent + '\n' + after;

  fs.writeFileSync('README.md', updated, 'utf8');
}

// Main orchestration
async function main() {
  if (!TOKEN) {
    console.error('ERROR: GITHUB_TOKEN is not set');
    process.exit(1);
  }

  try {
    console.log('Fetching GitHub data...');
    const [repos, events] = await Promise.all([
      fetchRepos(),
      fetchEvents(),
    ]);

    console.log(`Got ${repos.length} repos and ${events.length} events`);

    const insights = computeInsights(repos, events);
    const markdown = renderMarkdown(insights);

    console.log('Inserting markers...');
    insertMarkers(markdown);

    console.log('Profile insights updated successfully.');
    process.exit(0);
  } catch (err) {
    console.error('ERROR: Failed to generate insights:', err.message);
    process.exit(1);
  }
}

main();
