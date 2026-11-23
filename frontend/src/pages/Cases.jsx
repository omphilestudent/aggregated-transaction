import { useEffect, useState } from 'react'
import {
  AlertCircle, Briefcase, CheckCircle2, ChevronDown, ChevronRight, History,
  Loader2, RefreshCw, Search, UserRound, Wallet,
} from 'lucide-react'
import { getCase, getCaseActivity, getCases, updateCase } from '../services/caseService'
import { getAccountById } from '../services/accountService'
import { getCustomerById } from '../services/customerService'
import TransactionHistory from './TransactionHistory'
import './Cases.css'

export const CASE_STATUS_PATH = ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING', 'ESCALATED', 'RESOLVED', 'CLOSED']

const STATUS_LABEL = {
  NEW: 'New', OPEN: 'Open', IN_PROGRESS: 'In Progress', PENDING: 'Pending',
  ESCALATED: 'Escalated', RESOLVED: 'Resolved', CLOSED: 'Closed',
}

const PRIORITY_LABEL = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' }

const PRIORITY_CLASS = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' }

const ALLOWED_NEXT = {
  NEW: ['OPEN', 'IN_PROGRESS', 'PENDING', 'ESCALATED', 'RESOLVED'],
  OPEN: ['IN_PROGRESS', 'PENDING', 'ESCALATED', 'RESOLVED'],
  IN_PROGRESS: ['PENDING', 'ESCALATED', 'RESOLVED'],
  PENDING: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED'],
  ESCALATED: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
}

const ACTIVITY_LABEL = {
  CREATED: 'Case created',
  STATUS_CHANGED: 'Status changed',
  PRIORITY_CHANGED: 'Priority changed',
  ASSIGNED: 'Assignment changed',
  OWNER_CHANGED: 'Owner changed',
  DESCRIPTION_UPDATED: 'Description updated',
}

const errorMessage = (err) => {
  if (!err.response) return 'The API gateway cannot be reached.'
  const data = err.response.data
  if (data?.fieldErrors) return Object.values(data.fieldErrors).join(' ')
  return data?.message || 'The request failed.'
}

const formatMoney = (value, currency = 'ZAR') =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(Number(value ?? 0))

const formatDate = (value) =>
  value ? new Date(value).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

const formatDay = (value) =>
  value ? new Date(value).toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'

const initials = (name) => (name || '?').split(' ').slice(0, 2).map((p) => p[0]).join('').toUpperCase()

function useRequest(run, deps) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let active = true
    setState({ status: 'loading', data: null, error: '' })
    run()
      .then((data) => { if (active) setState({ status: 'ready', data, error: '' }) })
      .catch((err) => { if (active) setState({ status: 'error', data: null, error: errorMessage(err) }) })
    return () => { active = false }
  }, [...deps, version])

  return { ...state, reload: () => setVersion((v) => v + 1) }
}

function Priority({ value }) {
  return (
    <span className={`sf-priority ${PRIORITY_CLASS[value] || ''}`}>
      <i aria-hidden="true" />
      {PRIORITY_LABEL[value] || value}
    </span>
  )
}

function Section({ title, children }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="sf-section">
      <button className="sf-section-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <h3>{title}</h3>
      </button>
      {open && <div className="sf-section-body">{children}</div>}
    </section>
  )
}

function FieldGrid({ fields }) {
  return (
    <div className="sf-fields">
      {fields.map(([label, value]) => (
        <div key={label} className="sf-field">
          <div className="sf-field-label">{label}</div>
          <div className="sf-field-value">{value || <span className="sf-blank">—</span>}</div>
        </div>
      ))}
    </div>
  )
}

function Panel({ state, onRetry, children }) {
  if (state.status === 'loading') {
    return <div className="sf-skeleton-stack" role="status" aria-label="Loading">
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '100%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '92%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '96%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '70%' }} />
      </div>;
  }
  if (state.status === 'error') {
    return (
      <div className="cu-banner danger" role="alert">
        <AlertCircle size={18} /> <span>{state.error}</span>
        <button className="home-btn" onClick={onRetry}>Retry</button>
      </div>
    )
  }
  return children
}

export function CaseList({ onOpen }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [page, setPage] = useState(0)
  const [term, setTerm] = useState('')

  const list = useRequest(
    () => getCases({ q: term, status, priority, page, size: 20 }),
    [term, status, priority, page],
  )

  const submitSearch = (event) => {
    event.preventDefault()
    setPage(0)
    setTerm(query.trim())
  }

  const data = list.data
  const count = data?.totalElements ?? 0

  return (
    <section className="sf-list">
      <div className="sf-list-head">
        <div>
          <span className="sf-kicker">Cases</span>
          <h1>All Cases</h1>
          <span className="sf-muted">
            {data ? `${count} item${count === 1 ? '' : 's'} • Newest first` : 'Loading…'}
          </span>
        </div>
        <div className="sf-list-tools">
          <form className="sf-search-form" onSubmit={submitSearch} role="search">
            <label className="sf-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search case number, subject or customer ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search cases"
              />
            </label>
          </form>
          <select value={status} onChange={(e) => { setPage(0); setStatus(e.target.value) }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {CASE_STATUS_PATH.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <select value={priority} onChange={(e) => { setPage(0); setPriority(e.target.value) }} aria-label="Filter by priority">
            <option value="">All priorities</option>
            {Object.keys(PRIORITY_LABEL).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
          <button className="sf-pill-btn" onClick={list.reload} aria-label="Refresh cases">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <Panel state={list} onRetry={list.reload}>
        <div className="sf-card sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>Case Number</th>
                <th>Subject</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data?.content.length === 0 && (
                <tr><td colSpan={6} className="sf-empty">No cases match these filters.</td></tr>
              )}
              {data?.content.map((c) => (
                <tr key={c.id}>
                  <td><button className="sf-link-button" onClick={() => onOpen(c.id)}>{c.caseNumber}</button></td>
                  <td>{c.subject}</td>
                  <td><Priority value={c.priority} /></td>
                  <td>{STATUS_LABEL[c.status] || c.status}</td>
                  <td>{c.owner || '—'}</td>
                  <td>{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.totalPages > 1 && (
          <div className="home-actions">
            <button className="sf-btn outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span className="sf-muted">Page {page + 1} of {data.totalPages}</span>
            <button className="sf-btn outline" disabled={page + 1 >= data.totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </Panel>
    </section>
  )
}

export function CaseRecord({ caseId, onBack, onOpenCustomer }) {
  const [tab, setTab] = useState('details')
  const caseRequest = useRequest(() => getCase(caseId), [caseId])
  const activity = useRequest(() => getCaseActivity(caseId), [caseId])
  const caseData = caseRequest.data

  const accountRequest = useRequest(
    () => (caseData?.accountId ? getAccountById(caseData.accountId) : Promise.resolve(null)),
    [caseData?.accountId],
  )
  const customerRequest = useRequest(
    () => (caseData?.customerId ? getCustomerById(caseData.customerId) : Promise.resolve(null)),
    [caseData?.customerId],
  )

  const reloadAll = () => {
    caseRequest.reload()
    activity.reload()
  }

  const [pathSaving, setPathSaving] = useState(false)
  const [pathError, setPathError] = useState('')

  const changeStatus = async (next) => {
    setPathSaving(true)
    setPathError('')
    try {
      await updateCase(caseData.id, { status: next })
      reloadAll()
    } catch (err) {
      setPathError(errorMessage(err))
    } finally {
      setPathSaving(false)
    }
  }

  if (caseRequest.status !== 'ready') {
    return (
      <section className="sf-record">
        <button className="sf-pill-btn" onClick={onBack}>Back to cases</button>
        <Panel state={caseRequest} onRetry={caseRequest.reload}>{null}</Panel>
      </section>
    )
  }

  const closed = caseData.status === 'CLOSED'

  return (
    <div className="sf-record">
      <header className="sf-record-head">
        <div className="sf-title-row">
          <div className="sf-title">
            <span className="sf-icon case" aria-hidden="true"><Briefcase size={20} /></span>
            <div>
              <span className="sf-kicker">Case · {caseData.caseNumber}</span>
              <h1>{caseData.subject}</h1>
            </div>
          </div>
          <div className="sf-actions">
            <button className="sf-pill-btn" onClick={onBack}>Back to cases</button>
            <button className="sf-pill-btn" onClick={reloadAll}><RefreshCw size={14} /> Refresh</button>
          </div>
        </div>

        <dl className="sf-highlights">
          <div><dt>Priority</dt><dd><Priority value={caseData.priority} /></dd></div>
          <div><dt>Status</dt><dd>{STATUS_LABEL[caseData.status] || caseData.status}</dd></div>
          <div><dt>Case Number</dt><dd>{caseData.caseNumber}</dd></div>
          <div><dt>Owner</dt><dd>{caseData.owner || '—'}</dd></div>
          <div><dt>Investigator</dt><dd>{caseData.assignedInvestigator || 'Unassigned'}</dd></div>
        </dl>

        <div className="sf-path-row">
          <ol className="sf-path" aria-label="Case status">
            {CASE_STATUS_PATH.map((step) => {
              const current = step === caseData.status
              const reachable = (ALLOWED_NEXT[caseData.status] || []).includes(step)
              return (
                <li
                  key={step}
                  className={current ? (closed ? 'current closed' : 'current') : ''}
                  aria-current={current ? 'step' : undefined}
                >
                  {reachable ? (
                    <button
                      type="button"
                      className="sf-path-step-button"
                      disabled={pathSaving}
                      onClick={() => changeStatus(step)}
                      title={`Move this case to ${STATUS_LABEL[step]}`}
                    >
                      {STATUS_LABEL[step]}
                    </button>
                  ) : (
                    STATUS_LABEL[step]
                  )}
                </li>
              )
            })}
          </ol>
          {pathError && <p className="cu-banner danger" role="alert">{pathError}</p>}
        </div>
      </header>

      <div className="sf-body">
        <div className="sf-card sf-main">
          <div className="sf-tabs" role="tablist">
            {[
              ['details', 'Details'],
              ['transactions', 'Transaction History'],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="sf-tabpanel" role="tabpanel">
            {tab === 'details' && (
              <CaseDetails caseData={caseData} onSaved={reloadAll} closed={closed} />
            )}
            {tab === 'transactions' && (
              <Panel state={accountRequest} onRetry={accountRequest.reload}>
                {accountRequest.data
                  ? <TransactionHistory customerId={caseData.customerId} account={accountRequest.data} />
                  : <p className="sf-muted centered">This case is not linked to an account.</p>}
              </Panel>
            )}
          </div>
        </div>

        <aside className="sf-side">
          <div className="sf-card sf-side-card">
            <h2><UserRound size={16} /> Customer</h2>
            <Panel state={customerRequest} onRetry={customerRequest.reload}>
              {customerRequest.data ? (
                <div className="sf-related-list">
                  <button className="sf-related-row" onClick={() => onOpenCustomer(customerRequest.data.id)}>
                    <span className="sf-avatar">{initials(`${customerRequest.data.firstName} ${customerRequest.data.lastName}`)}</span>
                    <span className="acc-row-body">
                      <span className="acc-row-title">{customerRequest.data.firstName} {customerRequest.data.lastName}</span>
                      <span className="acc-row-meta">{customerRequest.data.email}</span>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </div>
              ) : <p className="sf-muted">No customer is linked to this case.</p>}
            </Panel>
          </div>

          <div className="sf-card sf-side-card">
            <h2><Wallet size={16} /> Account</h2>
            <Panel state={accountRequest} onRetry={accountRequest.reload}>
              {accountRequest.data ? (
                <dl className="sf-highlights stacked">
                  <div><dt>Account Number</dt><dd>{accountRequest.data.accountNumber}</dd></div>
                  <div><dt>Type</dt><dd>{accountRequest.data.accountType}</dd></div>
                  <div><dt>Status</dt><dd>{accountRequest.data.status}</dd></div>
                  <div><dt>Balance</dt><dd>{formatMoney(accountRequest.data.balance, accountRequest.data.currency)}</dd></div>
                </dl>
              ) : <p className="sf-muted">No account is linked to this case.</p>}
            </Panel>
          </div>

          <div className="sf-card sf-side-card">
            <h2><History size={16} /> Activity</h2>
            <Panel state={activity} onRetry={activity.reload}>
              {activity.data?.length === 0 && <p className="sf-muted">No activity recorded.</p>}
              <ul className="home-list">
                {[...(activity.data || [])].reverse().map((a) => (
                  <li key={a.id}>
                    <div className="home-list-main">
                      <strong>{ACTIVITY_LABEL[a.activityType] || a.activityType}</strong>
                      <span className="home-muted">{a.description}</span>
                      <span className="home-muted">{a.actor} · {formatDate(a.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </aside>
      </div>
    </div>
  )
}

function CaseDetails({ caseData, onSaved, closed }) {
  const allowed = ALLOWED_NEXT[caseData.status] || []
  const [form, setForm] = useState({
    status: caseData.status,
    priority: caseData.priority,
    assignedInvestigator: caseData.assignedInvestigator || '',
    owner: caseData.owner || '',
    resolutionDetails: caseData.resolutionDetails || '',
  })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    setForm({
      status: caseData.status,
      priority: caseData.priority,
      assignedInvestigator: caseData.assignedInvestigator || '',
      owner: caseData.owner || '',
      resolutionDetails: caseData.resolutionDetails || '',
    })
  }, [caseData])

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    const changes = {}
    if (form.priority !== caseData.priority) changes.priority = form.priority
    if (form.assignedInvestigator.trim() !== (caseData.assignedInvestigator || '')) {
      changes.assignedInvestigator = form.assignedInvestigator.trim()
    }
    if (form.owner.trim() !== (caseData.owner || '')) changes.owner = form.owner.trim()
    if (form.resolutionDetails.trim() && form.resolutionDetails.trim() !== (caseData.resolutionDetails || '')) {
      changes.resolutionDetails = form.resolutionDetails.trim()
    }
    if (Object.keys(changes).length === 0) {
      setNotice({ tone: 'danger', text: 'Nothing has changed.' })
      setSaving(false)
      return
    }
    try {
      await updateCase(caseData.id, changes)
      setNotice({ tone: 'success', text: 'Case updated.' })
      onSaved()
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Section title="Case Information">
        <FieldGrid fields={[
          ['Case Number', caseData.caseNumber],
          ['Subject', caseData.subject],
          ['Status', STATUS_LABEL[caseData.status] || caseData.status],
          ['Priority', PRIORITY_LABEL[caseData.priority] || caseData.priority],
          ['Case Type', caseData.caseType.replace(/_/g, ' ')],
          ['Origin', caseData.origin.replace(/_/g, ' ')],
          ['Created', formatDate(caseData.createdAt)],
          ['Last Modified', formatDate(caseData.updatedAt)],
          ['Closed', formatDate(caseData.closedAt)],
        ]} />
        <div className="sf-long-block">
          <span className="sf-field-label">Description</span>
          <p>{caseData.description || 'No description.'}</p>
        </div>
      </Section>

      <Section title="Ownership and Investigation">
        <FieldGrid fields={[
          ['Owner', caseData.owner],
          ['Assigned Investigator', caseData.assignedInvestigator],
          ['Resolution Details', caseData.resolutionDetails],
        ]} />
      </Section>

      <Section title="Update Case">
        {closed ? (
          <p className="sf-muted">This case is closed and can no longer be changed.</p>
        ) : (
          <form className="acc-form" onSubmit={submit} aria-busy={saving}>
            {notice && (
              <div className={`cu-banner ${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>
                {notice.tone === 'danger' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                <span>{notice.text}</span>
              </div>
            )}
            <div className="acc-form-grid">
              <div className="acc-field">
                <label htmlFor="case-priority">Priority</label>
                <select
                  id="case-priority"
                  value={form.priority}
                  disabled={saving}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                >
                  {Object.keys(PRIORITY_LABEL).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </div>
              <div className="acc-field">
                <label htmlFor="case-investigator">Assigned investigator</label>
                <input
                  id="case-investigator"
                  maxLength={100}
                  value={form.assignedInvestigator}
                  disabled={saving}
                  onChange={(e) => setForm((f) => ({ ...f, assignedInvestigator: e.target.value }))}
                />
              </div>
              <div className="acc-field">
                <label htmlFor="case-owner">Owner</label>
                <input
                  id="case-owner"
                  maxLength={100}
                  value={form.owner}
                  disabled={saving}
                  onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                />
              </div>
            </div>
            <div className="acc-field">
              <label htmlFor="case-resolution">Resolution details (required to resolve or close)</label>
              <textarea
                id="case-resolution"
                rows={3}
                maxLength={5000}
                value={form.resolutionDetails}
                disabled={saving}
                onChange={(e) => setForm((f) => ({ ...f, resolutionDetails: e.target.value }))}
              />
            </div>
            <div className="acc-form-actions">
              <button type="submit" className="sf-btn primary" disabled={saving}>
                {saving ? <Loader2 size={15} className="cu-spin" /> : null}
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        )}
      </Section>
    </>
  )
}
