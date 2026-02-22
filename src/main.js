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
    </main>
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
    app.innerHTML = `${Header()}${Dashboard()}`
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

  // Bind repo list items initially
  bindRepoItemEvents()
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
