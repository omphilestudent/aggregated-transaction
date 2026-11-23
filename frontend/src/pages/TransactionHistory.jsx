import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Building2 } from 'lucide-react'
import { getAccountsByCustomer } from '../services/accountService'
import { getTransactionSummary, getTransactionsByAccount } from '../services/transactionService'
import '../pages/Transactions.css'

// Transaction history for one customer's account: date presets, account and money-type filters,
// totals and a per-transaction detail row. Reads from transaction-service (ledger) through the gateway.

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

function Panel({ state, onRetry, children }) {
  if (state.status === 'loading') {
    return (
      <div className="sf-skeleton-stack" role="status" aria-label="Loading">
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '100%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '92%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '96%' }} />
        <span className="sf-skeleton sf-skeleton-row" style={{ width: '70%' }} />
      </div>
    )
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

const ACCOUNT_TYPE_LABEL = { SAVINGS: 'Savings', CHEQUE: 'Cheque', CREDIT: 'Credit' }

const DATE_PRESETS = [
  { key: '7', label: 'Last 7 Days', days: 7 },
  { key: '30', label: 'Last 30 Days', days: 30 },
  { key: '90', label: 'Last 90 Days', days: 90 },
  { key: 'all', label: 'All Dates' },
]

const isoDay = (date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + n))
}
const inclusiveSpan = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1

function TransactionHistory({ customerId, account }) {
  const today = useMemo(() => isoDay(new Date()), [])

  const accounts = useRequest(
    () => (customerId ? getAccountsByCustomer(customerId) : Promise.resolve([])),
    [customerId],
  )
  const accountList = useMemo(() => {
    const list = [...(accounts.data || [])]
    if (account && !list.some((a) => a.id === account.id)) list.unshift(account)
    return list
  }, [accounts.data, account])
  const accountTypes = useMemo(
    () => [...new Set(accountList.map((a) => a.accountType))],
    [accountList],
  )

  const [accountType, setAccountType] = useState('ALL')
  const visibleAccounts = accountList.filter((a) => accountType === 'ALL' || a.accountType === accountType)
  const [selectedAccountId, setSelectedAccountId] = useState(account?.id ?? null)
  const selectedAccount = visibleAccounts.find((a) => a.id === selectedAccountId) ?? visibleAccounts[0] ?? null

  const [preset, setPreset] = useState('30')
  const [from, setFrom] = useState(addDays(today, -29))
  const [to, setTo] = useState(today)
  const [moneyType, setMoneyType] = useState('ALL')
  const [openRow, setOpenRow] = useState(null)

  const [applied, setApplied] = useState(null)
  const [result, setResult] = useState({ status: 'idle', rows: [], summary: null, error: '' })
  const requestSeq = useRef(0)

  const rangeInvalid = Boolean(from && to && from > to)

  const runQuery = (criteria) => {
    if (!criteria.accountId) return
    const seq = ++requestSeq.current
    setApplied(criteria)
    setOpenRow(null)
    setResult({ status: 'loading', rows: [], summary: null, error: '' })
    const filter = { from: criteria.from, to: criteria.to, type: criteria.type }
    Promise.all([
      getTransactionsByAccount(criteria.accountId, filter),
      getTransactionSummary(criteria.accountId, filter),
    ])
      .then(([rows, summary]) => {
        if (seq === requestSeq.current) setResult({ status: 'ready', rows, summary, error: '' })
      })
      .catch((err) => {
        if (seq === requestSeq.current) setResult({ status: 'error', rows: [], summary: null, error: errorMessage(err) })
      })
  }

  const currentCriteria = (overrides = {}) => ({
    accountId: selectedAccount?.id,
    accountNumber: selectedAccount?.accountNumber,
    from,
    to,
    type: moneyType,
    ...overrides,
  })

  const applyPreset = (option) => {
    setPreset(option.key)
    if (option.key === 'all') {
      setFrom('')
      setTo('')
    } else {
      setFrom(addDays(today, -(option.days - 1)))
      setTo(today)
    }
  }

  const editDate = (setter) => (e) => {
    setPreset('custom')
    setter(e.target.value)
  }

  const shiftPeriod = (direction) => {
    if (!from || !to) return
    const span = inclusiveSpan(from, to)
    const nextFrom = addDays(from, direction * span)
    const nextTo = addDays(to, direction * span)
    setPreset('custom')
    setFrom(nextFrom)
    setTo(nextTo)
    runQuery(currentCriteria({ from: nextFrom, to: nextTo }))
  }

  const canShiftForward = Boolean(to) && to < today

  return (
    <div className="txn">
      <div className="txn-subtab">Transaction History · Account {selectedAccount?.accountNumber || '—'}</div>

      <Panel state={accounts} onRetry={accounts.reload}>
        <div className="txn-filters">
          <div className="txn-field">
            <span>Select</span>
            <div className="sf-segmented">
              {DATE_PRESETS.map((option) => (
                <button
                  key={option.key}
                  className={preset === option.key ? 'active' : ''}
                  onClick={() => applyPreset(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="txn-field">
            <span>From Date</span>
            <input type="date" value={from} max={to || undefined} onChange={editDate(setFrom)} />
          </label>
          <label className="txn-field">
            <span>To Date</span>
            <input type="date" value={to} min={from || undefined} max={today} onChange={editDate(setTo)} />
          </label>
          <label className="txn-field">
            <span>Account Type</span>
            <select
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              disabled={accountList.length === 0}
            >
              <option value="ALL">All account types</option>
              {accountTypes.map((t) => (
                <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t] || t}</option>
              ))}
            </select>
          </label>
          <label className="txn-field">
            <span>Account Number</span>
            <select
              value={selectedAccount?.id ?? ''}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              disabled={visibleAccounts.length === 0}
            >
              {visibleAccounts.length === 0 && <option value="">No accounts</option>}
              {visibleAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} · {ACCOUNT_TYPE_LABEL[a.accountType] || a.accountType}
                </option>
              ))}
            </select>
          </label>
          <label className="txn-field">
            <span>Money Type</span>
            <select value={moneyType} onChange={(e) => setMoneyType(e.target.value)}>
              <option value="ALL">ALL</option>
              <option value="CREDIT">CREDIT</option>
              <option value="DEBIT">DEBIT</option>
            </select>
          </label>
        </div>

        {rangeInvalid && (
          <p className="cu-banner danger txn-range-error" role="alert">
            <AlertCircle size={18} /> <span>The From Date must be on or before the To Date.</span>
          </p>
        )}

        <div className="txn-account-card">
          <div className="txn-account-title">
            <span className="sf-icon account" aria-hidden="true"><Building2 size={18} /></span>
            <div>
              <strong>Account</strong>
              <span>
                {selectedAccount
                  ? `${selectedAccount.accountNumber} · ${ACCOUNT_TYPE_LABEL[selectedAccount.accountType] || selectedAccount.accountType}`
                  : 'No account selected'}
              </span>
            </div>
          </div>
          <div className="txn-account-actions">
            <button
              className="sf-btn primary"
              disabled={!selectedAccount || rangeInvalid}
              onClick={() => runQuery(currentCriteria())}
            >
              Get Transactions
            </button>
            <button className="sf-btn outline" disabled title="Dispute workflow not connected yet">Dispute Transaction</button>
          </div>
        </div>

        {applied && (
          <div className="txn-period">
            <button
              className="sf-btn outline"
              disabled={!from || !to || result.status === 'loading'}
              onClick={() => shiftPeriod(-1)}
            >
              ‹ Earlier period
            </button>
            <span className="sf-muted">
              {from && to ? `${from} to ${to}` : 'All dates'}
            </span>
            <button
              className="sf-btn outline"
              disabled={!canShiftForward || result.status === 'loading'}
              onClick={() => shiftPeriod(1)}
            >
              Later period ›
            </button>
          </div>
        )}

        {!applied ? (
          <p className="sf-muted centered">No transactions to display. Click <strong>Get Transactions</strong> to load results.</p>
        ) : result.status === 'loading' ? (
          <div className="sf-skeleton-stack" role="status" aria-label="Loading">
                <span className="sf-skeleton sf-skeleton-row" style={{ width: '100%' }} />
                <span className="sf-skeleton sf-skeleton-row" style={{ width: '92%' }} />
                <span className="sf-skeleton sf-skeleton-row" style={{ width: '96%' }} />
                <span className="sf-skeleton sf-skeleton-row" style={{ width: '70%' }} />
              </div>
        ) : result.status === 'error' ? (
          <div className="cu-banner danger" role="alert">
            <AlertCircle size={18} /> <span>{result.error}</span>
            <button className="home-btn" onClick={() => runQuery(applied)}>Retry</button>
          </div>
        ) : (
          <TransactionResults
            criteria={applied}
            rows={result.rows}
            summary={result.summary}
            openRow={openRow}
            onToggle={(id) => setOpenRow((current) => (current === id ? null : id))}
          />
        )}
      </Panel>
    </div>
  )
}

function TransactionResults({ criteria, rows, summary, openRow, onToggle }) {
  return (
    <>
      <div className="txn-totals" aria-label="Totals for the selected filters">
        <div><span>Transactions</span><strong>{summary?.transactionCount ?? rows.length}</strong></div>
        <div><span>Credits</span><strong className="credit">{formatMoney(summary?.creditTotal)}</strong></div>
        <div><span>Debits</span><strong className="debit">{formatMoney(summary?.debitTotal)}</strong></div>
        <div><span>Net</span><strong>{formatMoney(summary?.netTotal)}</strong></div>
      </div>

      {rows.length === 0 ? (
        <p className="sf-muted centered">No transactions match these filters.</p>
      ) : (
        <div className="sf-table-wrap inset">
          <table className="sf-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const open = openRow === t.id
                return (
                  <Fragment key={t.id}>
                    <tr>
                      <td>{formatDate(t.createdAt)}</td>
                      <td>
                        <strong>{t.description || '—'}</strong>
                        <small>{t.transactionReference}</small>
                      </td>
                      <td className={t.type === 'CREDIT' ? 'credit' : 'debit'}>{t.type}</td>
                      <td className={`num ${t.type === 'CREDIT' ? 'credit' : 'debit'}`}>
                        {t.type === 'CREDIT' ? '+' : '−'}{formatMoney(t.amount, t.currency)}
                      </td>
                      <td>{t.status}</td>
                      <td>
                        <button
                          className="sf-link-button"
                          aria-expanded={open}
                          onClick={() => onToggle(t.id)}
                        >
                          {open ? 'Hide' : 'Details'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="txn-detail">
                        <td colSpan={6}>
                          <dl>
                            <div><dt>Reference</dt><dd>{t.transactionReference}</dd></div>
                            <div><dt>Transaction ID</dt><dd>{t.id}</dd></div>
                            <div><dt>Account</dt><dd>{criteria.accountNumber}</dd></div>
                            <div><dt>Recorded</dt><dd>{formatDate(t.createdAt)}</dd></div>
                            <div><dt>Status</dt><dd>{t.status}</dd></div>
                            <div><dt>Currency</dt><dd>{t.currency}</dd></div>
                            <div><dt>Description</dt><dd>{t.description || '—'}</dd></div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}


export default TransactionHistory
