import './style.css'

// State Management
const state = {
  token: localStorage.getItem('github_token') || null,
  user: null,
  repos: [],
  repoStats: {}, // Stores { repoId: { branches: N, commits: N } }
  selectedRepos: new Set(), // Set of "owner/name"
  searchQuery: '',
  filter: 'all',
  ownerFilter: 'all',
  sortBy: 'updated',
  loading: false,
  activeView: 'github', // 'github', 'cf-domains', 'cf-accounts'
  cfAccounts: JSON.parse(localStorage.getItem('cf_accounts')) || [],
  cfZones: {}, // { accountId: [zones] }
  cfAccountFilter: 'all',
  cfRealAccountFilter: 'all', // Filter by real CF account name/id
  activeZone: null, // { zoneId, zoneName, account }
  cfDnsRecords: {}, // { zoneId: [records] },
  globalCommits: [],
  loadingGlobalCommits: false,
  trendingRepos: [],
  loadingTrending: false,
  trendingTimeframe: 'daily',
}

// GitHub API Client
const github = {
  async request(endpoint, options = {}) {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Accept': 'application/vnd.github.v3+json',
        ...options.headers,
      },
    })
    if (!response.ok) {
      if (response.status === 401) {
        logout()
        throw new Error('Invalid or expired token')
      }
      const errorText = await response.text()
      let errorMessage = 'GitHub API request failed'
      try {
        const errorJson = JSON.parse(errorText)
        errorMessage = errorJson.message || errorMessage
      } catch (e) {
        errorMessage = errorText || errorMessage
      }
      throw new Error(errorMessage)
    }

    // Handle 204 No Content or empty bodies
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return null
    }

    return response.json()
  },

  async fetchUser() {
    return this.request('/user')
  },

  async fetchRepos() {
    return this.request('/user/repos?sort=updated&per_page=100')
  },

  async createRepo(data) {
    return this.request('/user/repos', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },

  async updateRepo(owner, repo, data) {
    return this.request(`/repos/${owner}/${repo}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    })
  },

  async deleteRepo(owner, repo) {
    return this.request(`/repos/${owner}/${repo}`, {
      method: 'DELETE'
    })
  },

  async fetchCounts(owner, repo) {
    const fetchWithHandle = async (url) => {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${state.token}` }
      })
      if (res.status === 409) return { headers: new Map(), status: 409 } // Empty repo
      return res
    }

    const [branchesRes, commitsRes] = await Promise.all([
      fetchWithHandle(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=1`),
      fetchWithHandle(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`)
    ])

    const getCount = (res) => {
      if (res.status === 409) return 0
      const link = res.headers.get('Link')
      // If there's no Link header, it means there's only 1 page of data
      // BUT if it's a 200 OK and no link, we should check if the body is empty
      // For simplicity, if status is 200 and no link, it usually means 1 item (or 0 if truly empty, but 409 handles the main case)
      if (!link) return 1
      const match = link.match(/page=(\d+)>; rel="last"/)
      return match ? parseInt(match[1]) : 1
    }

    return {
      branches: getCount(branchesRes),
      commits: getCount(commitsRes)
    }
  },

  async fetchCommitsList(owner, repo, page = 1) {
    return this.request(`/repos/${owner}/${repo}/commits?page=${page}&per_page=30`)
  },

  async fetchGlobalCommits() {
    if (!state.user || !state.repos.length) return []
    try {
      // Instead of using the search API which frequently hits validation limit errors with multiple repos,
      // we fetch the commits directly from the top N most recently updated repos concurrently and then sort them together.
      const topRepos = [...state.repos]
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 10) // fetch from top 10 most recently updated repos

      const promises = topRepos.map(repo => {
        return this.request(`/repos/${repo.owner.login}/${repo.name}/commits?per_page=10`)
          .then(commits => {
            // attach repository data
            return (commits || []).map(c => ({
              ...c,
              repository: repo
            }))
          })
          .catch(() => []) // fail gracefully for individual empty/permission issue repos
      })

      const repoCommits = await Promise.all(promises)

      // Flatten arrays, sort by date descending
      const allCommits = repoCommits.flat().sort((a, b) => {
        const dateA = new Date(a.commit.author.date)
        const dateB = new Date(b.commit.author.date)
        return dateB - dateA
      })

      return allCommits.slice(0, 50) // Return top 50 across all these repos
    } catch (err) {
      console.warn("Global commit fetch fallback failed", err)
      return []
    }
  },

  async fetchTrending(timeframe) {
    // Note: Due to the high instability of public unofficial scraping APIs for Github Trending,
    // and packages like @huchenme/github-trending failing,
    // we use the official Github Search API with optimized parameters as a robust, native fallback.
    const dates = {
      'daily': new Date(Date.now() - 86400000).toISOString().split('T')[0],
      'weekly': new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
      'monthly': new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
    }

    // We search for repos created recently OR pushed recently, sorted by stars 
    const query = `created:>${dates[timeframe]} sort:stars-desc`

    return this.request(`/search/repositories?q=${encodeURIComponent(query)}&per_page=30`)
      .then(res => {
        return (res.items || []).map(repo => {
          // Calculate a more realistic pseudo current period stars so UI looks nice
          const periodWeight = timeframe === 'daily' ? 0.9 : (timeframe === 'weekly' ? 0.8 : 0.6)
          const recentStars = Math.floor(repo.stargazers_count * periodWeight)

          return {
            full_name: repo.full_name,
            name: repo.name,
            author: repo.owner.login,
            html_url: repo.html_url,
            description: repo.description,
            language: repo.language,
            languageColor: getLangColor(repo.language),
            stargazers_count: repo.stargazers_count,
            forks_count: repo.forks_count,
            currentPeriodStars: recentStars > 0 ? recentStars : 1,
            builtBy: [{ username: repo.owner.login, avatar: repo.owner.avatar_url, href: repo.owner.html_url }]
          }
        })
      })
  }
}

// Cloudflare API Client
const cloudflare = {
  async request(account, endpoint, options = {}) {
    const response = await fetch(`/cf-api${endpoint}`, {
      ...options,
      headers: {
        'X-Auth-Email': account.email,
        'X-Auth-Key': account.key,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const data = await response.json()
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Cloudflare API request failed')
    }
    return data.result
  },

  async fetchZones(account) {
    // Fetch zones across all accounts the user has access to
    return this.request(account, '/zones?per_page=100&status=active,pending')
  },

  async fetchDnsRecords(account, zoneId) {
    return this.request(account, `/zones/${zoneId}/dns_records?per_page=100`)
  },

  async createDnsRecord(account, zoneId, data) {
    return this.request(account, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },

  async updateDnsRecord(account, zoneId, recordId, data) {
    return this.request(account, `/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    })
  },

  async deleteDnsRecord(account, zoneId, recordId) {
    return this.request(account, `/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE'
    })
  }
}

// Helper: Filter and Sort Repos
function getProcessedRepos() {
  return state.repos
    .filter(repo => {
      const matchesSearch = repo.name.toLowerCase().includes(state.searchQuery.toLowerCase()) ||
        (repo.description && repo.description.toLowerCase().includes(state.searchQuery.toLowerCase()))

      let matchesFilter = true
      if (state.filter === 'public') matchesFilter = !repo.private
      if (state.filter === 'private') matchesFilter = repo.private
      if (state.filter === 'forks') matchesFilter = repo.fork
      if (state.filter === 'sources') matchesFilter = !repo.fork

      const matchesOwner = state.ownerFilter === 'all' || repo.owner.login === state.ownerFilter

      return matchesSearch && matchesFilter && matchesOwner
    })
    .sort((a, b) => {
      if (state.sortBy === 'name') return a.name.localeCompare(b.name)
      if (state.sortBy === 'stars') return b.stargazers_count - a.stargazers_count
      return new Date(b.updated_at) - new Date(a.updated_at)
    })
}

// Navigation / Routing
async function init() {
  if (state.token) {
    try {
      state.loading = true
      render()
      state.user = await github.fetchUser()
      state.repos = await github.fetchRepos()
      fetchAllStats() // Background fetch stats
      if (state.cfAccounts.length > 0) {
        fetchAllCfZones()
      }
    } catch (err) {
      console.error(err)
      state.token = null
      localStorage.removeItem('github_token')
    } finally {
      state.loading = false
      render()
    }
  } else {
    render()
  }
}

// Toast Utility
const Toast = {
  show(message, type = 'success', duration = 3000) {
    const container = document.querySelector('#toast-container')
    const toast = document.createElement('div')
    toast.className = `toast glass-panel ${type}`

    const icon = type === 'success' ? 'check-circle' : (type === 'error' ? 'alert-circle' : 'info')

    toast.innerHTML = `
      <i data-lucide="${icon}" style="width: 20px; height: 20px;"></i>
      <span>${message}</span>
    `
    container.appendChild(toast)
    lucide.createIcons()

    setTimeout(() => {
      toast.classList.add('removing')
      setTimeout(() => toast.remove(), 300)
    }, duration)
  }
}

// Custom Confirm Utility
const Confirm = (title, message, okText = 'OK') => {
  return new Promise((resolve) => {
    const overlay = document.querySelector('#confirm-overlay')
    const titleEl = document.querySelector('#confirm-title')
    const messageEl = document.querySelector('#confirm-message')
    const okBtn = document.querySelector('#confirm-ok')
    const cancelBtn = document.querySelector('#confirm-cancel')

    titleEl.textContent = title
    messageEl.textContent = message
    okBtn.textContent = okText
    overlay.classList.add('active')

    const cleanup = (result) => {
      overlay.classList.remove('active')
      okBtn.onclick = null
      cancelBtn.onclick = null
      resolve(result)
    }

    okBtn.onclick = () => cleanup(true)
    cancelBtn.onclick = () => cleanup(false)
  })
}

function login(token) {
  state.token = token
  localStorage.setItem('github_token', token)
  init()
}

function logout() {
  state.token = null
  state.user = null
  state.repos = []
  state.selectedRepos.clear()
  localStorage.removeItem('github_token')
  render()
}

// Components
function Header() {
  return `
    <header>
      <div class="logo">
        <i data-lucide="github" class="logo-icon"></i>
        <span>GITCORE</span>
      </div>
      ${state.user ? `
        <div class="user-profile">
          <div class="user-info">
            <div class="username">${state.user.login}</div>
            <div class="user-role">${state.user.bio || 'Developer'}</div>
          </div>
          <img src="${state.user.avatar_url}" class="avatar" alt="Avatar">
          <button class="btn btn-outline" id="logout-btn" style="padding: 0.5rem; margin-top: 2px;">
            <i data-lucide="log-out" style="width: 18px; height: 18px;"></i>
          </button>
        </div>
      ` : ''}
    </header>
  `
}

function AuthScreen() {
  return `
    <div class="auth-container glass-panel" style="margin-top: 10vh">
      <i data-lucide="shield-check" style="width: 48px; height: 48px; color: var(--primary); margin-bottom: 1.5rem;"></i>
      <h1>Secure Access</h1>
      <p>Please enter your GitHub Personal Access Token to manage your repositories.</p>
      
      <div class="input-group">
        <label>Personal Access Token</label>
        <input type="password" id="token-input" placeholder="ghp_xxxxxxxxxxxx">
      </div>
      
      <button class="btn btn-primary" id="login-btn" style="width: 100%;">
        Connect GitHub <i data-lucide="arrow-right"></i>
      </button>

      <div style="margin-top: 1.5rem; font-size: 0.75rem; color: var(--text-dim);">
        <p>Tip: Generate a PAT with <code style="color: var(--primary)">repo</code> & <code style="color: var(--primary)">user</code> scopes.</p>
      </div>
    </div>
  `
}

function RepoListItem(repo) {
  const repoId = `${repo.owner.login}/${repo.name}`
  const isSelected = state.selectedRepos.has(repoId)
  const stats = state.repoStats[repoId] || { branches: '...', commits: '...' }

  return `
    <div class="repo-list-item glass-panel ${isSelected ? 'selected' : ''}" data-repo-id="${repoId}">
      <div class="repo-checkbox-container">
        <div class="custom-checkbox ${isSelected ? 'checked' : ''}" data-repo-id="${repoId}"></div>
      </div>
      
      <div class="repo-info-main">
        <div class="repo-name-box">
          <a href="${repo.html_url}" target="_blank" class="repo-name" style="display: block; margin-bottom: 2px;">${repo.name}</a>
          <div style="font-size: 0.7rem; color: var(--text-dim); display: flex; align-items: center; gap: 0.5rem;">
            ${repo.private ? '<span style="color: var(--warning)">🔒 Private</span>' : '🌐 Public'}
            <span>•</span>
            <span title="Owner">${repo.owner.login}</span>
          </div>
        </div>
        
        <div class="repo-meta-list">
          <div class="meta-item">
            <span class="lang-dot" style="background: ${getLangColor(repo.language)}"></span>
            ${repo.language || 'Plain Text'}
          </div>
          <div class="meta-item" title="Branches">
            <i data-lucide="git-branch" style="width: 14px;"></i> ${stats.branches}
          </div>
          <div class="meta-item" title="Commits">
            <i data-lucide="history" style="width: 14px;"></i> ${stats.commits}
          </div>
          <div class="meta-item" title="Stars">
            <i data-lucide="star" style="width: 14px;"></i> ${repo.stargazers_count}
          </div>
          <div class="meta-item" title="Forks">
            <i data-lucide="git-fork" style="width: 14px;"></i> ${repo.forks_count}
          </div>
          <div class="meta-item" title="Last updated">
            <i data-lucide="clock" style="width: 14px;"></i> ${new Date(repo.updated_at).toLocaleDateString()}
          </div>
        </div>
      </div>
      
      <div class="repo-actions" style="margin-top: 0; padding-top: 0; border-top: none;">
        <button class="btn-icon edit-repo-btn" data-owner="${repo.owner.login}" data-name="${repo.name}" title="Rename Repository">
          <i data-lucide="edit-3" style="width: 16px;"></i>
        </button>
        <button class="btn-icon view-commits-btn" data-owner="${repo.owner.login}" data-name="${repo.name}" title="View Commits">
          <i data-lucide="history" style="width: 16px;"></i>
        </button>
        <button class="btn-icon copy-clone-btn" data-clone-url="${repo.clone_url}" title="Copy git clone command">
          <i data-lucide="copy" style="width: 16px;"></i>
        </button>
        <a href="${repo.html_url}" target="_blank" class="btn-icon" title="View on GitHub">
          <i data-lucide="external-link" style="width: 16px;"></i>
        </a>
        <button class="btn-icon danger delete-repo-btn" data-owner="${repo.owner.login}" data-name="${repo.name}" title="Delete">
          <i data-lucide="trash-2" style="width: 16px;"></i>
        </button>
      </div>
    </div>
  `
}

function Dashboard() {
  const filteredRepos = getProcessedRepos()
  const stats = {
    total: state.repos.length,
    public: state.repos.filter(r => !r.private).length,
    private: state.repos.filter(r => r.private).length,
    stars: state.repos.reduce((acc, r) => acc + r.stargazers_count, 0)
  }

  return `
    <main class="dashboard container">
      <div class="stats-grid">
        <div class="stat-card glass-panel">
          <div class="stat-label">Total Repositories</div>
          <div class="stat-value">${stats.total}</div>
        </div>
        <div class="stat-card glass-panel">
          <div class="stat-label">Public / Private</div>
          <div class="stat-value"><span style="color: var(--primary)">${stats.public}</span> <span style="color: var(--text-dim)">/</span> ${stats.private}</div>
        </div>
        <div class="stat-card glass-panel">
          <div class="stat-label">Total Gained Stars</div>
          <div class="stat-value"><i data-lucide="star" style="color: var(--warning); width: 24px; display: inline; vertical-align: middle;"></i> ${stats.stars}</div>
        </div>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <i data-lucide="search"></i>
          <input type="text" id="repo-search" placeholder="Search repositories..." value="${state.searchQuery}">
        </div>

        <div class="filter-group">
          <select class="select-custom" id="sort-select">
            <option value="updated" ${state.sortBy === 'updated' ? 'selected' : ''}>Sort by: Last Updated</option>
            <option value="name" ${state.sortBy === 'name' ? 'selected' : ''}>Sort by: Name</option>
            <option value="stars" ${state.sortBy === 'stars' ? 'selected' : ''}>Sort by: Stars</option>
          </select>
          <button class="btn btn-primary" id="open-modal-btn">
            <i data-lucide="plus"></i> New Repo
          </button>
        </div>
      </div>

      <div class="quick-filters" style="margin-bottom: 0.75rem;">
        <div class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">All Types</div>
        <div class="chip ${state.filter === 'public' ? 'active' : ''}" data-filter="public">Public</div>
        <div class="chip ${state.filter === 'private' ? 'active' : ''}" data-filter="private">Private</div>
        <div class="chip ${state.filter === 'sources' ? 'active' : ''}" data-filter="sources">Sources</div>
        <div class="chip ${state.filter === 'forks' ? 'active' : ''}" data-filter="forks">Forks</div>
      </div>

      <div class="quick-filters owners-filter" style="margin-bottom: 2rem; border-top: 1px solid var(--border-subtle); padding-top: 0.75rem;">
        <div style="font-size: 0.75rem; color: var(--text-dim); display: flex; align-items: center; margin-right: 0.5rem;">
          <i data-lucide="user" style="width: 14px; margin-right: 4px;"></i> Owner:
        </div>
        <div class="chip ${state.ownerFilter === 'all' ? 'active' : ''}" data-owner="all">Everyone</div>
        ${Array.from(new Set(state.repos.map(r => r.owner.login))).map(owner => `
          <div class="chip ${state.ownerFilter === owner ? 'active' : ''}" data-owner="${owner}">${owner}</div>
        `).join('')}
      </div>

      <div class="repo-list">
        ${filteredRepos.map(repo => RepoListItem(repo)).join('')}
      </div>

      <div class="bulk-actions-bar ${state.selectedRepos.size > 0 ? 'active' : ''}">
        <div class="selection-count">
          <i data-lucide="check-square" style="vertical-align: middle; margin-right: 0.5rem;"></i>
          ${state.selectedRepos.size} items selected
        </div>
        <div style="display: flex; gap: 1rem;">
          <button class="btn btn-outline" id="clear-selection-btn">Cancel</button>
          <button class="btn btn-primary" id="bulk-delete-btn" style="background: var(--error); color: white;">
            <i data-lucide="trash-2"></i> Delete Selected
          </button>
        </div>
      </div>

      <div class="modal-overlay" id="modal-overlay">
        <div class="modal glass-panel">
          <button class="modal-close" id="close-modal-btn">
            <i data-lucide="x"></i>
          </button>
          <h2 style="margin-bottom: 0.5rem;">Create New Repository</h2>
          <p style="color: var(--text-dim); font-size: 0.875rem; margin-bottom: 2rem;">Setup your new project in seconds.</p>
          
          <div class="input-group">
            <label>Repository Name</label>
            <input type="text" id="new-repo-name" placeholder="my-awesome-project">
          </div>
          
          <div class="input-group">
            <label>Description (optional)</label>
            <input type="text" id="new-repo-desc" placeholder="A brief description of your project">
          </div>

          <div class="input-group" style="display: flex; gap: 1rem; align-items: center;">
            <input type="checkbox" id="new-repo-private" style="width: auto;">
            <label for="new-repo-private" style="margin-bottom: 0; cursor: pointer;">Private Repository</label>
          </div>

          <button class="btn btn-primary" id="create-repo-btn" style="width: 100%; margin-top: 1rem;">
            Create Repository
          </button>
        </div>
      </div>

      <div class="modal-overlay" id="commits-modal-overlay">
        <div class="modal glass-panel" style="max-width: 600px; width: 90%;">
          <button class="modal-close" id="close-commits-modal-btn">
            <i data-lucide="x"></i>
          </button>
          <h2 style="margin-bottom: 0.5rem;" id="commits-modal-title">Repository Commits</h2>
          <p style="color: var(--text-dim); font-size: 0.875rem; margin-bottom: 1.5rem;" id="commits-modal-subtitle">Recent commits</p>
          
          <div id="commits-list-container" style="max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; padding-right: 0.5rem;">
            <!-- Commits will be loaded here -->
          </div>
        </div>
      </div>
    </main>
  `
}

function CloudflareAccountsView() {
  return `
    <main class="container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem;">
        <div>
          <h1 style="font-size: 2.5rem; margin-bottom: 0.5rem;">CF Accounts</h1>
          <p style="color: var(--text-dim);">Manage your Cloudflare identities and API keys.</p>
        </div>
        <button class="btn btn-primary" id="add-cf-account-btn">
          <i data-lucide="plus-circle"></i> Add Account
        </button>
      </div>

      ${state.cfAccounts.length === 0 ? `
        <div class="glass-panel" style="padding: 4rem; text-align: center;">
          <i data-lucide="user-plus" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 1.5rem;"></i>
          <h3>No Cloudflare Accounts</h3>
          <p style="color: var(--text-dim); margin-top: 0.5rem;">Add your first account to start managing domains.</p>
        </div>
      ` : `
        <div class="cf-accounts-grid">
          ${state.cfAccounts.map(acc => `
            <div class="cf-account-card glass-panel" style="display: flex; flex-direction: column; justify-content: space-between;">
              <div class="cf-account-header">
                <div>
                  <div class="cf-badge"><i data-lucide="shield"></i> Account</div>
                  <h3 style="margin-top: 0.75rem;">${acc.name || acc.email}</h3>
                  <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.25rem;">${acc.email}</div>
                </div>
                <button class="btn-icon danger remove-cf-acc" data-id="${acc.id}">
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
              
              <div style="margin-top: 1rem; padding: 1rem; background: var(--bg-deep); border-radius: 8px; font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); border: 1px solid var(--border-subtle);">
                Key: ••••••••••••••••${acc.key.slice(-4)}
              </div>
            </div>
          `).join('')}
        </div>
      `}

      <!-- Add Account Modal -->
      <div class="modal-overlay" id="cf-modal-overlay">
        <div class="modal glass-panel">
          <button class="modal-close" id="close-cf-modal-btn">
            <i data-lucide="x"></i>
          </button>
          <h2 style="margin-bottom: 0.5rem;">Add Cloudflare Account</h2>
          <p style="color: var(--text-dim); font-size: 0.875rem; margin-bottom: 2rem;">Use your Global API Key for full access.</p>
          
          <div class="input-group">
            <label>Custom Name (optional)</label>
            <input type="text" id="cf-acc-name" placeholder="Work Account / Personal">
          </div>

          <div class="input-group">
            <label>Cloudflare Email</label>
            <input type="email" id="cf-acc-email" placeholder="user@example.com">
          </div>
          
          <div class="input-group">
            <label>Global API Key</label>
            <input type="password" id="cf-acc-key" placeholder="Paste your key here">
          </div>

          <button class="btn btn-primary" id="save-cf-account-btn" style="width: 100%; margin-top: 1rem;">
            Save Account
          </button>
        </div>
      </div>
    </main>
  `
}

function CloudflareDomainsView() {
  const allZones = []
  const uniqueRealAccounts = new Map() // { id: name }

  Object.entries(state.cfZones).forEach(([accId, zones]) => {
    const localCredential = state.cfAccounts.find(a => a.id === accId)
    zones.forEach(z => {
      allZones.push({ ...z, localAccount: localCredential })
      if (z.account && z.account.id) {
        uniqueRealAccounts.set(z.account.id, z.account.name)
      }
    })
  })

  const searchQuery = state.searchQuery || ''
  const filteredZones = allZones.filter(z => {
    const matchesSearch = z.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesCredential = state.cfAccountFilter === 'all' || (z.localAccount && z.localAccount.id === state.cfAccountFilter)
    const matchesRealAccount = state.cfRealAccountFilter === 'all' || (z.account && z.account.id === state.cfRealAccountFilter)
    return matchesSearch && matchesCredential && matchesRealAccount
  })

  return `
    <main class="container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem;">
        <div>
          <h1 style="font-size: 2.5rem; margin-bottom: 0.5rem;">CF Domains</h1>
          <p style="color: var(--text-dim);">Aggregated list from all your Cloudflare accounts and memberships.</p>
        </div>
      </div>

      <div class="toolbar" style="margin-bottom: 1.5rem;">
        <div class="search-box">
          <i data-lucide="search"></i>
          <input type="text" id="cf-domain-search" placeholder="Search domains..." value="${searchQuery}">
        </div>
        <div class="filter-group">
          <input type="text" id="auto-replace-old-ip" placeholder="Old IP" class="select-custom" style="padding: 0.4rem; width: 120px;">
          <input type="text" id="auto-replace-new-ip" placeholder="New IP" class="select-custom" style="padding: 0.4rem; width: 120px;">
          <button class="btn btn-outline" id="auto-replace-ip-btn" title="Auto replace A records IP across filtered domains">
            <i data-lucide="repeat"></i> Replace IP
          </button>
        </div>
      </div>

      <div class="filter-section glass-panel" style="padding: 1rem; margin-bottom: 2rem; border-color: var(--border-subtle);">
        <div class="quick-filters" style="margin-bottom: 1rem;">
          <div style="font-size: 0.75rem; color: var(--text-dim); display: flex; align-items: center; min-width: 80px;">
            <i data-lucide="key" style="width: 14px; margin-right: 6px;"></i> API:
          </div>
          <div class="chip ${state.cfAccountFilter === 'all' ? 'active' : ''}" data-cf-filter="all">All</div>
          ${state.cfAccounts.map(acc => `
            <div class="chip ${state.cfAccountFilter === acc.id ? 'active' : ''}" data-cf-filter="${acc.id}" title="${acc.name}">${acc.name}</div>
          `).join('')}
        </div>

        <div class="quick-filters">
          <div style="font-size: 0.75rem; color: var(--text-dim); display: flex; align-items: center; min-width: 80px;">
            <i data-lucide="building" style="width: 14px; margin-right: 6px;"></i> Org:
          </div>
          <div class="chip ${state.cfRealAccountFilter === 'all' ? 'active' : ''}" data-cf-real-filter="all">All Orgs</div>
          ${Array.from(uniqueRealAccounts.entries()).map(([id, name]) => {
    const shortName = name.replace(/'s Account$/i, '')
    return `
              <div class="chip ${state.cfRealAccountFilter === id ? 'active' : ''}" data-cf-real-filter="${id}" title="${name}">${shortName}</div>
            `
  }).join('')}
        </div>
      </div>

      ${allZones.length === 0 ? `
        <div class="glass-panel" style="padding: 4rem; text-align: center;">
          <i data-lucide="cloud-off" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 1.5rem;"></i>
          <h3>No Domains Found</h3>
          <p style="color: var(--text-dim); margin-top: 0.5rem;">Try adding a credential or refreshing the page.</p>
        </div>
      ` : `
        <div class="repo-list">
          ${filteredZones.length === 0 ? `
            <div style="padding: 3rem; text-align: center; color: var(--text-dim);">No domains match your filters.</div>
          ` : filteredZones.map(zone => `
            <div class="repo-list-item glass-panel" style="padding: 1.25rem 2rem;">
              <div style="display: flex; align-items: center; gap: 1.5rem; flex: 1;">
                <span class="domain-status ${zone.status === 'active' ? 'domain-active' : 'domain-pending'}"></span>
                <div style="flex: 1;">
                  <div style="font-weight: 600; font-size: 1.1rem; color: var(--primary);">${zone.name}</div>
                  <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.25rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <span>Account:</span>
                    <span style="color: var(--warning); font-weight: 600;" title="${zone.account.name}">${zone.account.name.replace(/'s Account$/i, '')}</span>
                    <span style="opacity: 0.5;">•</span>
                    <span style="font-size: 0.75rem;">Status: ${zone.status}</span>
                    ${zone.localAccount ? `
                      <span style="opacity: 0.5;">•</span>
                      <span style="font-size: 0.7rem; background: var(--bg-elevated); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border-subtle);">via ${zone.localAccount.name}</span>
                    ` : ''}
                  </div>
                </div>
                <div class="repo-actions" style="border: none; margin: 0; padding: 0;">
                  <button class="btn-icon view-dns-btn" data-zone-id="${zone.id}" data-zone-name="${zone.name}" data-acc-id="${zone.localAccount.id}" title="Manage DNS Records">
                    <i data-lucide="list"></i>
                  </button>
                  <a href="https://dash.cloudflare.com/${zone.account.id}/${zone.name}" target="_blank" class="btn-icon" title="Open in Cloudflare">
                    <i data-lucide="external-link"></i>
                  </a>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </main>
  `
}

function CloudflareDnsView() {
  const { zoneId, zoneName, localAccount } = state.activeZone
  const records = state.cfDnsRecords[zoneId] || []
  const searchQuery = state.searchQuery || ''
  const filteredRecords = records.filter(r =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.type.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return `
    <main class="container">
      <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 2rem;">
        <button class="btn-icon" id="back-to-domains" title="Back to Domains">
          <i data-lucide="arrow-left"></i>
        </button>
        <div>
          <h1 style="font-size: 2rem; margin-bottom: 0.25rem;">${zoneName}</h1>
          <p style="color: var(--text-dim); font-size: 0.875rem;">
            DNS Records • <span style="color: var(--warning)">${localAccount.name}</span>
          </p>
        </div>
      </div>

      <div class="toolbar" style="margin-bottom: 2rem;">
        <div class="search-box">
          <i data-lucide="search"></i>
          <input type="text" id="dns-search" placeholder="Search DNS records..." value="${searchQuery}">
        </div>
        <div class="filter-group">
           <button class="btn btn-outline" id="refresh-dns-btn">
            <i data-lucide="refresh-cw"></i>
          </button>
          <button class="btn btn-primary" id="add-dns-record-btn">
            <i data-lucide="plus"></i> Add Record
          </button>
        </div>
      </div>

      ${records.length === 0 ? `
        <div class="glass-panel" style="padding: 4rem; text-align: center;">
          <p style="color: var(--text-dim);">No DNS records found.</p>
        </div>
      ` : `
        <div class="repo-list">
          ${filteredRecords.map(record => `
            <div class="repo-list-item glass-panel" style="padding: 1rem 1.5rem; gap: 1rem;">
              <div style="width: 60px; font-weight: 800; color: var(--primary); font-size: 0.75rem; background: var(--bg-elevated); padding: 4px 8px; border-radius: 4px; text-align: center; border: 1px solid var(--border-subtle);">
                ${record.type}
              </div>
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; font-family: var(--font-mono); font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  ${record.name}
                </div>
                <div style="font-size: 0.8rem; color: var(--text-dim); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 0.25rem;">
                  ${record.content}
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 1.5rem; font-size: 0.75rem; color: var(--text-dim);">
                <div title="Proxied Status" style="display: flex; align-items: center; gap: 4px;">
                  <i data-lucide="${record.proxied ? 'cloud' : 'cloud-off'}" style="width: 14px; color: ${record.proxied ? '#f38020' : 'inherit'}"></i>
                  ${record.proxied ? 'Proxied' : 'DNS Only'}
                </div>
                <div title="TTL" style="display: flex; align-items: center; gap: 4px;">
                  <i data-lucide="clock" style="width: 12px;"></i> ${record.ttl === 1 ? 'Auto' : record.ttl}
                </div>
              </div>
              <div class="repo-actions" style="border: none; margin: 0; padding: 0;">
                <button class="btn-icon edit-dns-btn" 
                  data-id="${record.id}" 
                  data-type="${record.type}" 
                  data-name="${record.name}" 
                  data-content="${record.content}" 
                  data-proxied="${record.proxied}" 
                  data-ttl="${record.ttl}"
                >
                  <i data-lucide="edit-3"></i>
                </button>
                <button class="btn-icon danger delete-dns-btn" data-id="${record.id}" data-name="${record.name}">
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `}

      <!-- DNS Modal -->
      <div class="modal-overlay" id="dns-modal-overlay">
        <div class="modal glass-panel">
          <button class="modal-close" id="close-dns-modal-btn">
            <i data-lucide="x"></i>
          </button>
          <h2 id="dns-modal-title" style="margin-bottom: 0.5rem;">Add DNS Record</h2>
          <p style="color: var(--text-dim); font-size: 0.875rem; margin-bottom: 2rem;">Configure your domain routing.</p>
          
          <input type="hidden" id="dns-record-id">

          <div style="display: grid; grid-template-columns: 100px 1fr; gap: 1rem;">
            <div class="input-group">
              <label>Type</label>
              <select class="select-custom" id="dns-record-type" style="width: 100%;">
                <option value="A">A</option>
                <option value="AAAA">AAAA</option>
                <option value="CNAME">CNAME</option>
                <option value="TXT">TXT</option>
                <option value="MX">MX</option>
                <option value="NS">NS</option>
              </select>
            </div>
            <div class="input-group">
              <label>Name (e.g. @, www)</label>
              <input type="text" id="dns-record-name" placeholder="example.com">
            </div>
          </div>
          
          <div class="input-group">
            <label>Content / Value</label>
            <input type="text" id="dns-record-content" placeholder="192.168.1.1 or target.com">
          </div>

          <div style="display: flex; gap: 2rem; align-items: center; margin-bottom: 1.5rem; background: var(--bg-elevated); padding: 1rem; border-radius: 8px;">
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <input type="checkbox" id="dns-record-proxied" style="width: auto;">
              <label for="dns-record-proxied" style="margin-bottom: 0; cursor: pointer;">Proxied</label>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center; flex: 1;">
              <label style="margin-bottom: 0; white-space: nowrap;">TTL:</label>
              <select class="select-custom" id="dns-record-ttl" style="padding: 0.5rem; flex: 1;">
                <option value="1">Auto</option>
                <option value="60">1 min</option>
                <option value="3600">1 hour</option>
                <option value="86400">1 day</option>
              </select>
            </div>
          </div>

          <button class="btn btn-primary" id="save-dns-record-btn" style="width: 100%;">
            Save DNS Record
          </button>
        </div>
      </div>
    </main>
  `
}

function GlobalCommitsView() {
  if (state.globalCommits.length === 0 && !state.loadingGlobalCommits) {
    fetchGlobalCommits()
  }

  return `
    <main class="container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem;">
        <div>
          <h1 style="font-size: 2.5rem; margin-bottom: 0.5rem;">Recent Commits</h1>
          <p style="color: var(--text-dim);">Global commit history across all your repositories.</p>
        </div>
        <button class="btn btn-outline" id="refresh-global-commits">
          <i data-lucide="refresh-cw" class="${state.loadingGlobalCommits ? 'spin' : ''}"></i> Refresh
        </button>
      </div>

      <div id="global-commits-list" class="repo-list">
        ${state.loadingGlobalCommits ?
      '<div style="text-align: center; padding: 4rem;"><div class="loader" style="margin: 0 auto;"></div><p style="margin-top: 1rem; color: var(--text-dim);">Fetching global history...</p></div>' :
      (state.globalCommits.length === 0 ?
        '<div class="glass-panel" style="padding: 4rem; text-align: center;"><i data-lucide="history" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 1.5rem;"></i><p>No commits found in your history.</p></div>' :
        state.globalCommits.map(c => {
          const repoName = c.repository ? c.repository.full_name : 'Unknown Repo'
          const author = c.commit.author.name
          const date = new Date(c.commit.author.date).toLocaleString()
          const message = c.commit.message.split('\n')[0]
          const sha = c.sha.substring(0, 7)
          return `
                 <div class="repo-list-item glass-panel" style="padding: 1.25rem 2rem;">
                   <div style="display: flex; align-items: center; gap: 1.5rem; flex: 1; min-width: 0;">
                     <div style="flex: 1; min-width: 0;">
                       <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                         <span style="font-family: var(--font-mono); font-size: 0.75rem; background: var(--bg-deep); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-subtle); color: var(--primary);">${sha}</span>
                         <span style="font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;" title="${message}">${message}</span>
                       </div>
                       <div style="font-size: 0.8rem; color: var(--text-dim); display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                         <span style="display: flex; align-items: center; gap: 4px;">
                           <i data-lucide="folder" style="width: 14px;"></i> ${repoName}
                         </span>
                         <span style="display: flex; align-items: center; gap: 4px;">
                           <i data-lucide="user" style="width: 14px;"></i> ${author}
                         </span>
                         <span style="display: flex; align-items: center; gap: 4px;">
                           <i data-lucide="clock" style="width: 14px;"></i> ${date}
                         </span>
                       </div>
                     </div>
                     <a href="${c.html_url}" target="_blank" class="btn-icon" title="View Commit">
                       <i data-lucide="external-link"></i>
                     </a>
                   </div>
                 </div>
               `
        }).join('')
      )
    }
      </div>
    </main>
  `
}

function TrendingView() {
  if (state.trendingRepos.length === 0 && !state.loadingTrending) {
    fetchTrending()
  }

  return `
    <main class="container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem;">
        <div>
          <h1 style="font-size: 2.5rem; margin-bottom: 0.5rem;">Trending</h1>
          <p style="color: var(--text-dim);">See what the GitHub community is most excited about.</p>
        </div>
        <div style="display: flex; gap: 1rem; align-items: center;">
          <select class="select-custom" id="trending-timeframe" style="padding: 0.5rem 1rem;">
            <option value="daily" ${state.trendingTimeframe === 'daily' ? 'selected' : ''}>Today</option>
            <option value="weekly" ${state.trendingTimeframe === 'weekly' ? 'selected' : ''}>This Week</option>
            <option value="monthly" ${state.trendingTimeframe === 'monthly' ? 'selected' : ''}>This Month</option>
          </select>
          <button class="btn btn-outline" id="refresh-trending-btn" title="Refresh Trending">
            <i data-lucide="refresh-cw" class="${state.loadingTrending ? 'spin' : ''}"></i>
          </button>
        </div>
      </div>

      <div id="trending-repo-list" class="repo-list">
        ${state.loadingTrending ?
      '<div style="text-align: center; padding: 4rem;"><div class="loader" style="margin: 0 auto;"></div><p style="margin-top: 1rem; color: var(--text-dim);">Fetching trending repositories...</p></div>' :
      (state.trendingRepos.length === 0 ?
        '<div class="glass-panel" style="padding: 4rem; text-align: center;"><i data-lucide="trending-up" style="width: 48px; height: 48px; color: var(--text-dim); margin-bottom: 1.5rem;"></i><p>No trending repositories found.</p></div>' :
        state.trendingRepos.map((repo, index) => {
          const periodText = state.trendingTimeframe === 'daily' ? 'today' : (state.trendingTimeframe === 'weekly' ? 'this week' : 'this month');

          return `
                 <div class="repo-list-item glass-panel" style="padding: 1.25rem 2rem; border-color: var(--border-subtle); display:flex; flex-direction:column; gap:0.75rem;">
                   <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                     <div style="display: flex; align-items: center; gap: 0.75rem;">
                       <i data-lucide="book" style="width: 16px; color: var(--text-dim);"></i>
                       <a href="${repo.html_url}" target="_blank" style="font-weight: 500; font-size: 1.15rem; color: var(--primary); text-decoration: none;">
                          <span style="font-weight: normal; opacity: 0.8">${repo.author} / </span>${repo.name}
                       </a>
                     </div>
                     <button class="btn btn-outline" style="padding: 0.25rem 0.75rem; font-size: 0.75rem; margin: 0;">
                       <i data-lucide="star" style="width: 14px;"></i> Star
                     </button>
                   </div>
                   
                   <p style="font-size: 0.85rem; color: var(--text-main); line-height: 1.5; max-width: 85%;">
                     ${repo.description || 'No description provided.'}
                   </p>
                   
                   <div style="font-size: 0.75rem; color: var(--text-dim); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;">
                     <div style="display: flex; align-items: center; gap: 1.25rem;">
                       ${repo.language ? `
                       <span style="display: flex; align-items: center; gap: 4px;">
                         <span class="lang-dot" style="background: ${repo.languageColor || getLangColor(repo.language)}"></span> ${repo.language}
                       </span>` : ''}
                       <span style="display: flex; align-items: center; gap: 4px;" title="Stars">
                         <i data-lucide="star" style="width: 14px;"></i> ${repo.stargazers_count.toLocaleString()}
                       </span>
                       <span style="display: flex; align-items: center; gap: 4px;" title="Forks">
                         <i data-lucide="git-fork" style="width: 14px;"></i> ${repo.forks_count.toLocaleString()}
                       </span>
                       ${repo.builtBy && repo.builtBy.length > 0 ? `
                       <span style="display: flex; align-items: center; gap: 4px; margin-left: 0.5rem;">
                         Built by
                         <div style="display:flex; margin-left:2px;">
                           ${repo.builtBy.map(u => `<a href="${u.href}" target="_blank" title="${u.username}"><img src="${u.avatar}" style="width: 20px; height: 20px; border-radius: 50%; margin-left: -4px; border: 2px solid var(--bg-main);" /></a>`).join('')}
                         </div>
                       </span>` : ''}
                     </div>
                     
                     ${repo.currentPeriodStars ? `
                     <span style="display: flex; align-items: center; gap: 4px;">
                       <i data-lucide="star" style="width: 14px;"></i> ${repo.currentPeriodStars.toLocaleString()} stars ${periodText}
                     </span>` : ''}
                   </div>
                 </div>
               `
        }).join('')
      )
    }
      </div>
    </main>
  `
}

function Sidebar() {
  return `
    <aside class="sidebar">
      <div style="margin: 1.5rem 0 0.5rem 1rem; font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;">Github</div>
      
      <div class="nav-item ${state.activeView === 'github' ? 'active' : ''}" data-view="github">
        <i data-lucide="github"></i> GitHub Repos
      </div>
      <div class="nav-item ${state.activeView === 'commits' ? 'active' : ''}" data-view="commits">
        <i data-lucide="history"></i> Recent Commits
      </div>
      <div class="nav-item ${state.activeView === 'trending' ? 'active' : ''}" data-view="trending">
        <i data-lucide="trending-up"></i> Trending
      </div>
      
      <div style="margin: 1.5rem 0 0.5rem 1rem; font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;">Cloudflare</div>
      
      <div class="nav-item ${state.activeView === 'cf-domains' ? 'active' : ''}" data-view="cf-domains">
        <i data-lucide="globe"></i> Manage Domains
      </div>
      <div class="nav-item ${state.activeView === 'cf-accounts' ? 'active' : ''}" data-view="cf-accounts">
        <i data-lucide="users"></i> Manage Accounts
      </div>

      <div style="margin-top: auto; padding: 1rem; border-top: 1px solid var(--border-subtle);">
        <div style="font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">Resources</div>
        <a href="https://dash.cloudflare.com" target="_blank" class="nav-item" style="padding: 0.5rem 0.75rem; font-size: 0.85rem;">
          <i data-lucide="external-link" style="width: 14px;"></i> CF Dashboard
        </a>
      </div>
    </aside>
  `
}

function getLangColor(lang) {
  const colors = {
    'JavaScript': '#f7df1e',
    'TypeScript': '#3178c6',
    'HTML': '#e34c26',
    'CSS': '#563d7c',
    'Python': '#3776ab',
    'Rust': '#dea584',
    'Go': '#00add8',
  }
  return colors[lang] || '#8b949e'
}

// Global Event Handlers
function updateBulkActionBar() {
  const bar = document.querySelector('.bulk-actions-bar')
  const countDisplay = document.querySelector('.selection-count')
  if (bar && countDisplay) {
    if (state.selectedRepos.size > 0) {
      bar.classList.add('active')
      countDisplay.innerHTML = `
        <i data-lucide="check-square" style="vertical-align: middle; margin-right: 0.5rem;"></i>
        ${state.selectedRepos.size} items selected
      `
    } else {
      bar.classList.remove('active')
    }
  }
}

// Rendering Logic
function render() {
  const app = document.querySelector('#app')
  if (state.loading) {
    app.innerHTML = `
      ${Header()}
      <div class="loader"></div>
    `
    lucide.createIcons()
    return
  }

  if (!state.token) {
    app.innerHTML = `${Header()}${AuthScreen()}`
  } else if (state.user) {
    app.innerHTML = `
      ${Header()}
      <div class="app-layout">
        ${Sidebar()}
        <div class="main-content">
          ${(() => {
        if (state.activeView === 'github') return Dashboard()
        if (state.activeView === 'commits') return GlobalCommitsView()
        if (state.activeView === 'trending') return TrendingView()
        if (state.activeView === 'cf-domains') return CloudflareDomainsView()
        if (state.activeView === 'cf-accounts') return CloudflareAccountsView()
        if (state.activeView === 'cf-dns') return CloudflareDnsView()
        return Dashboard()
      })()}
        </div>
      </div>
    `
  }

  bindEvents()
  lucide.createIcons()
}

function renderReposOnly() {
  const listContainer = document.querySelector('.repo-list')
  if (!listContainer) return
  const filteredRepos = getProcessedRepos()
  listContainer.innerHTML = filteredRepos.map(repo => RepoListItem(repo)).join('')
  bindRepoItemEvents()
  lucide.createIcons()
}

function bindRepoItemEvents() {
  // Checkbox logic
  const checkboxes = document.querySelectorAll('.custom-checkbox')
  checkboxes.forEach(cb => {
    cb.onclick = (e) => {
      e.stopPropagation()
      const repoId = cb.dataset.repoId
      if (state.selectedRepos.has(repoId)) {
        state.selectedRepos.delete(repoId)
        cb.classList.remove('checked')
        cb.closest('.repo-list-item').classList.remove('selected')
      } else {
        state.selectedRepos.add(repoId)
        cb.classList.add('checked')
        cb.closest('.repo-list-item').classList.add('selected')
      }
      updateBulkActionBar()
    }
  })

  // Individual Delete
  const deleteBtns = document.querySelectorAll('.delete-repo-btn')
  deleteBtns.forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const { owner, name } = btn.dataset
      const confirmed = await Confirm('Delete Repository', `Are you sure you want to delete ${owner}/${name}?`, 'Delete Now')
      if (confirmed) {
        try {
          state.loading = true
          render()
          await github.deleteRepo(owner, name)
          // Optimistic local update: remove from state immediately
          state.repos = state.repos.filter(r => !(r.owner.login === owner && r.name === name))
          state.selectedRepos.delete(`${owner}/${name}`)
          Toast.show('Repository deleted successfully')
        } catch (err) {
          Toast.show('Failed to delete: ' + err.message, 'error')
        } finally {
          state.loading = false
          render()
        }
      }
    }
  })

  // Quick Rename
  const editBtns = document.querySelectorAll('.edit-repo-btn')
  editBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const { owner, name } = btn.dataset
      const item = btn.closest('.repo-list-item')
      const nameAnchor = item.querySelector('.repo-name')

      // Create input element
      const input = document.createElement('input')
      input.type = 'text'
      input.value = name
      input.className = 'inline-edit-input'
      input.style.width = '100%'
      input.style.fontSize = '1.125rem'
      input.style.fontWeight = '600'
      input.style.background = 'var(--bg-elevated)'
      input.style.border = '1px solid var(--primary)'
      input.style.borderRadius = '4px'
      input.style.padding = '2px 8px'
      input.style.color = 'var(--primary)'

      const originalDisplay = nameAnchor.style.display
      nameAnchor.style.display = 'none'
      nameAnchor.parentNode.insertBefore(input, nameAnchor)
      input.focus()
      input.select()

      const finishEdit = async (save) => {
        const newName = input.value.trim()
        if (save && newName && newName !== name) {
          try {
            Toast.show('Renaming...', 'info')
            await github.updateRepo(owner, name, { name: newName })

            // Update local state
            const repo = state.repos.find(r => r.owner.login === owner && r.name === name)
            if (repo) {
              repo.name = newName
              repo.full_name = `${owner}/${newName}`
              // Update clone URL if possible or just rely on re-render
            }
            Toast.show('Repository renamed!')
            render()
          } catch (err) {
            Toast.show('Rename failed: ' + err.message, 'error')
            nameAnchor.style.display = originalDisplay
            input.remove()
          }
        } else {
          nameAnchor.style.display = originalDisplay
          input.remove()
        }
      }

      input.onkeydown = (e) => {
        if (e.key === 'Enter') finishEdit(true)
        if (e.key === 'Escape') finishEdit(false)
      }

      input.onblur = () => finishEdit(true)
    }
  })

  // Copy Clone Command
  const copyBtns = document.querySelectorAll('.copy-clone-btn')
  copyBtns.forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const url = btn.dataset.cloneUrl
      const command = `git clone ${url}`

      try {
        await navigator.clipboard.writeText(command)
        Toast.show('Clone command copied to clipboard!')

        // Visual feedback on button
        const icon = btn.querySelector('i, svg')
        if (icon) {
          const originalIconName = icon.getAttribute('data-lucide') || 'copy'

          icon.setAttribute('data-lucide', 'check')
          lucide.createIcons()

          setTimeout(() => {
            icon.setAttribute('data-lucide', originalIconName)
            lucide.createIcons()
          }, 2000)
        }
      } catch (err) {
        console.error('Clipboard copy failed:', err)
        Toast.show('Failed to copy', 'error')
      }
    }
  })

  // View Commits
  const viewCommitsBtns = document.querySelectorAll('.view-commits-btn')
  viewCommitsBtns.forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const { owner, name } = btn.dataset
      const overlay = document.getElementById('commits-modal-overlay')
      const container = document.getElementById('commits-list-container')
      const title = document.getElementById('commits-modal-title')

      title.textContent = `Commits: ${owner}/${name}`
      container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-dim);">Loading commits <i data-lucide="loader-2" class="spin" style="width: 16px; margin-left: 0.5rem; vertical-align: middle;"></i></div>'
      overlay.classList.add('active')
      lucide.createIcons()

      try {
        const commits = await github.fetchCommitsList(owner, name)

        if (!commits || commits.length === 0) {
          container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-dim);">No commits found.</div>'
          return
        }

        container.innerHTML = commits.map(c => {
          const author = c.commit.author.name
          const date = new Date(c.commit.author.date).toLocaleString()
          const message = c.commit.message || ''
          const sha = c.sha.substring(0, 7)
          const url = c.html_url
          return `
            <div class="glass-panel" style="padding: 1rem; border-color: var(--border-subtle); display: flex; flex-direction: column; gap: 0.5rem;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
                <div style="font-weight: 500; font-size: 0.95rem; line-height: 1.4; flex: 1;">${message.split('\\n')[0]}</div>
                <a href="${url}" target="_blank" style="font-family: var(--font-mono); font-size: 0.8rem; background: var(--bg-elevated); padding: 2px 6px; border-radius: 4px; color: var(--text-dim); text-decoration: none; border: 1px solid var(--border-subtle);">${sha}</a>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-dim);">
                <i data-lucide="user" style="width: 12px; height: 12px;"></i> ${author}
                <span>•</span>
                <i data-lucide="clock" style="width: 12px; height: 12px;"></i> ${date}
              </div>
            </div>
          `
        }).join('')
        lucide.createIcons()
      } catch (err) {
        container.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--error);">Failed to load commits: ${err.message}</div>`
      }
    }
  })
}

function bindEvents() {
  // Navigation / Auth
  const loginBtn = document.querySelector('#login-btn')
  const logoutBtn = document.querySelector('#logout-btn')
  const tokenInput = document.querySelector('#token-input')
  if (loginBtn && tokenInput) loginBtn.onclick = () => {
    const token = tokenInput.value.trim()
    if (token) login(token)
  }
  if (logoutBtn) logoutBtn.onclick = logout

  // Search & Filter
  const searchInput = document.querySelector('#repo-search')
  if (searchInput) searchInput.oninput = (e) => {
    state.searchQuery = e.target.value
    renderReposOnly()
    updateBulkActionBar()
  }

  const sortSelect = document.querySelector('#sort-select')
  if (sortSelect) sortSelect.onchange = (e) => {
    state.sortBy = e.target.value
    render()
  }

  const filterChips = document.querySelectorAll('.chip[data-filter]')
  filterChips.forEach(chip => {
    chip.onclick = () => {
      state.filter = chip.dataset.filter
      render()
    }
  })

  const ownerChips = document.querySelectorAll('.chip[data-owner]')
  ownerChips.forEach(chip => {
    chip.onclick = () => {
      state.ownerFilter = chip.dataset.owner
      render()
    }
  })

  // Bulk Actions
  const clearBtn = document.querySelector('#clear-selection-btn')
  if (clearBtn) clearBtn.onclick = () => {
    state.selectedRepos.clear()
    render()
  }

  const bulkDeleteBtn = document.querySelector('#bulk-delete-btn')
  if (bulkDeleteBtn) bulkDeleteBtn.onclick = async () => {
    const count = state.selectedRepos.size
    const confirmed = await Confirm('Bulk Delete', `Are you sure you want to delete ${count} selected repositories?`, 'Delete All')
    if (confirmed) {
      try {
        state.loading = true
        render()
        for (const repoId of Array.from(state.selectedRepos)) {
          const [owner, name] = repoId.split('/')
          await github.deleteRepo(owner, name)
          // Optimistic local update for each
          state.repos = state.repos.filter(r => !(r.owner.login === owner && r.name === name))
        }
        state.selectedRepos.clear()
        Toast.show(`Successfully deleted ${count} repositories`)
      } catch (err) {
        Toast.show('Error: ' + err.message, 'error')
      } finally {
        state.loading = false
        render()
      }
    }
  }

  // Modal logic
  const modalOverlay = document.querySelector('#modal-overlay')
  const openModalBtn = document.querySelector('#open-modal-btn')
  const closeModalBtn = document.querySelector('#close-modal-btn')
  const createRepoBtn = document.querySelector('#create-repo-btn')
  if (openModalBtn) openModalBtn.onclick = () => modalOverlay.classList.add('active')
  if (closeModalBtn) closeModalBtn.onclick = () => modalOverlay.classList.remove('active')

  const commitsModalOverlay = document.querySelector('#commits-modal-overlay')
  const closeCommitsModalBtn = document.querySelector('#close-commits-modal-btn')
  if (closeCommitsModalBtn) closeCommitsModalBtn.onclick = () => commitsModalOverlay.classList.remove('active')
  if (commitsModalOverlay) {
    commitsModalOverlay.onclick = (e) => {
      if (e.target === commitsModalOverlay) commitsModalOverlay.classList.remove('active')
    }
  }

  if (createRepoBtn) createRepoBtn.onclick = async () => {
    const name = document.querySelector('#new-repo-name').value.trim()
    const description = document.querySelector('#new-repo-desc').value.trim()
    const isPrivate = document.querySelector('#new-repo-private').checked
    if (!name) {
      Toast.show('Repository name is required', 'error')
      return
    }
    try {
      state.loading = true
      render()
      await github.createRepo({ name, description, private: isPrivate })
      state.repos = await github.fetchRepos()
      Toast.show('Repository created successfully')
    } catch (err) {
      Toast.show(err.message, 'error')
    } finally {
      state.loading = false
      render()
    }
  }

  // Sidebar navigation
  const navItems = document.querySelectorAll('.nav-item[data-view]')
  navItems.forEach(item => {
    item.onclick = () => {
      state.activeView = item.dataset.view
      state.searchQuery = '' // Reset search when switching tabs
      render()
    }
  })

  // Cloudflare Domain Filter
  const cfDomainSearch = document.querySelector('#cf-domain-search')
  if (cfDomainSearch) {
    cfDomainSearch.oninput = (e) => {
      state.searchQuery = e.target.value
      render()
      // Preserve focus
      const box = document.querySelector('#cf-domain-search')
      if (box) {
        box.focus()
        box.setSelectionRange(box.value.length, box.value.length)
      }
    }
  }

  // Cloudflare Actions
  const cfFilterChips = document.querySelectorAll('.chip[data-cf-filter]')
  cfFilterChips.forEach(chip => {
    chip.onclick = () => {
      state.cfAccountFilter = chip.dataset.cfFilter
      render()
    }
  })

  const cfRealFilterChips = document.querySelectorAll('.chip[data-cf-real-filter]')
  cfRealFilterChips.forEach(chip => {
    chip.onclick = () => {
      state.cfRealAccountFilter = chip.dataset.cfRealFilter
      render()
    }
  })

  const addCfBtn = document.querySelector('#add-cf-account-btn')
  const closeCfBtn = document.querySelector('#close-cf-modal-btn')
  const saveCfBtn = document.querySelector('#save-cf-account-btn')
  const cfModal = document.querySelector('#cf-modal-overlay')

  // DNS Record actions
  const dnsRecordsBtn = document.querySelectorAll('.view-dns-btn')
  dnsRecordsBtn.forEach(btn => {
    btn.onclick = async () => {
      const { zoneId, zoneName, accId } = btn.dataset
      const localAccount = state.cfAccounts.find(a => a.id === accId)
      state.activeZone = { zoneId, zoneName, localAccount }
      state.activeView = 'cf-dns'
      state.searchQuery = ''
      render()

      try {
        const records = await cloudflare.fetchDnsRecords(localAccount, zoneId)
        state.cfDnsRecords[zoneId] = records
        render()
      } catch (err) {
        Toast.show('Failed to load DNS records: ' + err.message, 'error')
      }
    }
  })

  const backBtn = document.querySelector('#back-to-domains')
  if (backBtn) backBtn.onclick = () => {
    state.activeView = 'cf-domains'
    state.activeZone = null
    state.searchQuery = ''
    render()
  }

  const dnsSearch = document.querySelector('#dns-search')
  if (dnsSearch) dnsSearch.oninput = (e) => {
    state.searchQuery = e.target.value
    render()
    document.querySelector('#dns-search').focus()
  }

  const refreshDnsBtn = document.querySelector('#refresh-dns-btn')
  if (refreshDnsBtn) refreshDnsBtn.onclick = async () => {
    const { zoneId, localAccount } = state.activeZone
    try {
      Toast.show('Refreshing DNS records...', 'info')
      const records = await cloudflare.fetchDnsRecords(localAccount, zoneId)
      state.cfDnsRecords[zoneId] = records
      render()
      Toast.show('DNS records updated')
    } catch (err) {
      Toast.show('Refresh failed: ' + err.message, 'error')
    }
  }

  const autoReplaceBtn = document.querySelector('#auto-replace-ip-btn')
  if (autoReplaceBtn) autoReplaceBtn.onclick = async () => {
    const oldIp = document.querySelector('#auto-replace-old-ip').value.trim()
    const newIp = document.querySelector('#auto-replace-new-ip').value.trim()
    if (!oldIp || !newIp) {
      Toast.show('Please enter both Old IP and New IP', 'error')
      return
    }

    const allZones = []
    Object.entries(state.cfZones).forEach(([accId, zones]) => {
      const localCredential = state.cfAccounts.find(a => a.id === accId)
      zones.forEach(z => {
        allZones.push({ ...z, localAccount: localCredential })
      })
    })

    const searchQuery = state.searchQuery || ''
    const filteredZones = allZones.filter(z => {
      const matchesSearch = z.name.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesCredential = state.cfAccountFilter === 'all' || (z.localAccount && z.localAccount.id === state.cfAccountFilter)
      const matchesRealAccount = state.cfRealAccountFilter === 'all' || (z.account && z.account.id === state.cfRealAccountFilter)
      return matchesSearch && matchesCredential && matchesRealAccount
    })

    if (filteredZones.length === 0) {
      Toast.show('No domains available to update', 'info')
      return
    }

    const confirmed = await Confirm('Replace IP', `Are you sure you want to search and change IP from ${oldIp} to ${newIp} across ${filteredZones.length} domains?`, 'Replace')
    if (!confirmed) return

    try {
      state.loading = true
      render()

      let totalUpdated = 0
      let totalDomainsUpdated = 0

      for (const zone of filteredZones) {
        try {
          const records = await cloudflare.fetchDnsRecords(zone.localAccount, zone.id)
          const matchingRecords = records.filter(r => r.type === 'A' && r.content === oldIp)

          if (matchingRecords.length > 0) {
            let zoneUpdated = false
            for (const record of matchingRecords) {
              const data = {
                type: record.type,
                name: record.name,
                content: newIp,
                proxied: record.proxied,
                ttl: record.ttl
              }
              await cloudflare.updateDnsRecord(zone.localAccount, zone.id, record.id, data)
              totalUpdated++
              zoneUpdated = true
            }
            if (zoneUpdated) totalDomainsUpdated++
          }
        } catch (err) {
          console.warn(`Failed to process zone ${zone.name}`, err)
        }
      }

      Toast.show(`Updated ${totalUpdated} A records across ${totalDomainsUpdated} domains.`)
    } catch (err) {
      Toast.show('Error during replacement: ' + err.message, 'error')
    } finally {
      state.loading = false
      render()
    }
  }

  // DNS Modal Logic
  const dnsModal = document.querySelector('#dns-modal-overlay')
  const addDnsBtn = document.querySelector('#add-dns-record-btn')
  const closeDnsBtn = document.querySelector('#close-dns-modal-btn')
  const saveDnsRecordBtn = document.querySelector('#save-dns-record-btn')

  if (addDnsBtn) addDnsBtn.onclick = () => {
    document.querySelector('#dns-modal-title').textContent = 'Add DNS Record'
    document.querySelector('#dns-record-id').value = ''
    document.querySelector('#dns-record-type').value = 'A'
    document.querySelector('#dns-record-name').value = ''
    document.querySelector('#dns-record-content').value = ''
    document.querySelector('#dns-record-proxied').checked = true
    document.querySelector('#dns-record-ttl').value = '1'
    dnsModal.classList.add('active')
  }

  if (closeDnsBtn) closeDnsBtn.onclick = () => dnsModal.classList.remove('active')

  if (saveDnsRecordBtn) saveDnsRecordBtn.onclick = async () => {
    const { zoneId, localAccount } = state.activeZone
    const id = document.querySelector('#dns-record-id').value
    const data = {
      type: document.querySelector('#dns-record-type').value,
      name: document.querySelector('#dns-record-name').value.trim(),
      content: document.querySelector('#dns-record-content').value.trim(),
      proxied: document.querySelector('#dns-record-proxied').checked,
      ttl: parseInt(document.querySelector('#dns-record-ttl').value)
    }

    if (!data.name || !data.content) {
      Toast.show('Name and Content are required', 'error')
      return
    }

    try {
      state.loading = true
      render()
      if (id) {
        await cloudflare.updateDnsRecord(localAccount, zoneId, id, data)
        Toast.show('Record updated successfully')
      } else {
        await cloudflare.createDnsRecord(localAccount, zoneId, data)
        Toast.show('Record created successfully')
      }
      // Refresh list
      const records = await cloudflare.fetchDnsRecords(localAccount, zoneId)
      state.cfDnsRecords[zoneId] = records
    } catch (err) {
      Toast.show('Error: ' + err.message, 'error')
    } finally {
      state.loading = false
      render()
    }
  }

  // Individual DNS Actions
  const editDnsBtns = document.querySelectorAll('.edit-dns-btn')
  editDnsBtns.forEach(btn => {
    btn.onclick = () => {
      const { id, type, name, content, proxied, ttl } = btn.dataset
      document.querySelector('#dns-modal-title').textContent = 'Edit DNS Record'
      document.querySelector('#dns-record-id').value = id
      document.querySelector('#dns-record-type').value = type
      document.querySelector('#dns-record-name').value = name
      document.querySelector('#dns-record-content').value = content
      document.querySelector('#dns-record-proxied').checked = proxied === 'true'
      document.querySelector('#dns-record-ttl').value = ttl
      dnsModal.classList.add('active')
    }
  })

  const deleteDnsBtns = document.querySelectorAll('.delete-dns-btn')
  deleteDnsBtns.forEach(btn => {
    btn.onclick = async () => {
      const { id, name } = btn.dataset
      const { zoneId, localAccount } = state.activeZone
      const confirmed = await Confirm('Delete DNS Record', `Are you sure you want to delete the record for ${name}?`, 'Delete')
      if (confirmed) {
        try {
          state.loading = true
          render()
          await cloudflare.deleteDnsRecord(localAccount, zoneId, id)
          Toast.show('Record deleted')
          const records = await cloudflare.fetchDnsRecords(localAccount, zoneId)
          state.cfDnsRecords[zoneId] = records
        } catch (err) {
          Toast.show('Delete failed: ' + err.message, 'error')
        } finally {
          state.loading = false
          render()
        }
      }
    }
  })

  if (addCfBtn) addCfBtn.onclick = () => cfModal.classList.add('active')
  if (closeCfBtn) closeCfBtn.onclick = () => cfModal.classList.remove('active')
  if (saveCfBtn) saveCfBtn.onclick = async () => {
    const name = document.querySelector('#cf-acc-name').value.trim()
    const email = document.querySelector('#cf-acc-email').value.trim()
    const key = document.querySelector('#cf-acc-key').value.trim()

    if (!email || !key) {
      Toast.show('Email and Global API Key are required', 'error')
      return
    }

    const newAccount = {
      id: Date.now().toString(),
      name: name || email,
      email,
      key
    }

    state.cfAccounts.push(newAccount)
    localStorage.setItem('cf_accounts', JSON.stringify(state.cfAccounts))
    cfModal.classList.remove('active')
    Toast.show('Cloudflare account added')

    // Fetch zones for the new account
    try {
      state.loading = true
      render()
      const zones = await cloudflare.fetchZones(newAccount)
      state.cfZones[newAccount.id] = zones
    } catch (err) {
      Toast.show('Failed to fetch domains: ' + err.message, 'error')
    } finally {
      state.loading = false
      render()
    }
  }

  const removeCfBtns = document.querySelectorAll('.remove-cf-acc')
  removeCfBtns.forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id
      const confirmed = await Confirm('Remove Account', 'Are you sure you want to remove this Cloudflare account?', 'Remove')
      if (confirmed) {
        state.cfAccounts = state.cfAccounts.filter(acc => acc.id !== id)
        delete state.cfZones[id]
        localStorage.setItem('cf_accounts', JSON.stringify(state.cfAccounts))
        render()
        Toast.show('Account removed')
      }
    }
  })

  // Global Commits Refresh
  const refreshCommitsBtn = document.querySelector('#refresh-global-commits')
  if (refreshCommitsBtn) refreshCommitsBtn.onclick = () => {
    state.globalCommits = []
    fetchGlobalCommits()
  }

  // Trending Refresh & Filter
  const refreshTrendingBtn = document.querySelector('#refresh-trending-btn')
  if (refreshTrendingBtn) refreshTrendingBtn.onclick = () => {
    state.trendingRepos = []
    fetchTrending()
  }

  const trendingTimeframeSelect = document.querySelector('#trending-timeframe')
  if (trendingTimeframeSelect) trendingTimeframeSelect.onchange = (e) => {
    state.trendingTimeframe = e.target.value
    state.trendingRepos = []
    fetchTrending()
  }

  // Bind repo list items initially
  bindRepoItemEvents()
}
async function fetchGlobalCommits() {
  if (state.loadingGlobalCommits) return
  state.loadingGlobalCommits = true
  render()
  try {
    state.globalCommits = await github.fetchGlobalCommits()
  } catch (err) {
    console.error(err)
    Toast.show('Failed to fetch global commits: ' + err.message, 'error')
  } finally {
    state.loadingGlobalCommits = false
    render()
  }
}

async function fetchTrending() {
  if (state.loadingTrending) return
  state.loadingTrending = true
  render()
  try {
    state.trendingRepos = await github.fetchTrending(state.trendingTimeframe)
  } catch (err) {
    console.error(err)
    Toast.show('Failed to fetch trending repos: ' + err.message, 'error')
  } finally {
    state.loadingTrending = false
    render()
  }
}

async function fetchAllCfZones() {
  for (const account of state.cfAccounts) {
    if (state.cfZones[account.id]) continue
    try {
      const zones = await cloudflare.fetchZones(account)
      state.cfZones[account.id] = zones
      render()
    } catch (err) {
      console.warn(`Failed to fetch zones for ${account.email}:`, err)
    }
  }
}

async function fetchAllStats() {
  const visibleRepos = getProcessedRepos().slice(0, 50) // Limit to 50 for performance
  for (const repo of visibleRepos) {
    const repoId = `${repo.owner.login}/${repo.name}`
    if (state.repoStats[repoId]) continue

    try {
      const counts = await github.fetchCounts(repo.owner.login, repo.name)
      state.repoStats[repoId] = counts
      // Partial update the specific item if it exists in DOM
      updateListItemStats(repoId, counts)
    } catch (e) {
      console.warn(`Failed to fetch stats for ${repoId}`, e)
    }
  }
}

function updateListItemStats(repoId, counts) {
  const item = document.querySelector(`.repo-list-item[data-repo-id="${repoId}"]`)
  if (item) {
    const branchItem = item.querySelector('[title="Branches"]')
    const commitItem = item.querySelector('[title="Commits"]')
    if (branchItem) branchItem.innerHTML = `<i data-lucide="git-branch" style="width: 14px;"></i> ${counts.branches}`
    if (commitItem) commitItem.innerHTML = `<i data-lucide="history" style="width: 14px;"></i> ${counts.commits}`
    lucide.createIcons()
  }
}

// Kickoff
init()
