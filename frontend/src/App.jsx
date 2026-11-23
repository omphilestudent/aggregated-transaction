import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowDownLeft, ArrowUpRight, Database, RefreshCcw, Layers3 } from 'lucide-react'
import api from './services/api.js'
import './index.css'

const today = () => new Date().toISOString().slice(0, 10)
const monthAgo = () => { const d = new Date(); d.setDate(d.getDate()-29); return d.toISOString().slice(0,10) }
const currency = (n) => new Intl.NumberFormat('en-ZA', {style:'currency', currency:'ZAR'}).format(Number(n||0))
const sources = ['BANK_FEED','CARD_NETWORK','OPEN_BANKING']
const readable = (name) => (name||'').replaceAll('_',' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
const message = (e) => e?.response?.data?.message || e?.response?.data?.error || e.message || 'Request failed'

export default function App() {
  const [customers, setCustomers] = useState([])
  const [customerId, setCustomerId] = useState('')
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState('')
  const [customerForm, setCustomerForm] = useState({firstName:'',lastName:'',email:''})
  const [auth, setAuth] = useState('')
  const [period, setPeriod] = useState({from:monthAgo(),to:today()})
  const [importOptions, setImportOptions] = useState({source:'BANK_FEED',count:100,seed:42})
  const [filters, setFilters] = useState({category:'',direction:'',page:0})
  const [summary, setSummary] = useState(null)
  const [categories, setCategories] = useState([])
  const [trends, setTrends] = useState([])
  const [transactions, setTransactions] = useState({items:[],totalElements:0,totalPages:0})
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const secured = useCallback((token) => ({headers:{Authorization:`Bearer ${token}`}}), [])
  const loadCustomers = useCallback(async () => {const {data}=await api.get('/customers');setCustomers(data)}, [])
  useEffect(()=>{loadCustomers().catch(e=>setError(message(e)))},[loadCustomers])
  useEffect(()=>{
    if (!customerId) {setAccounts([]);setAccountId('');setAuth('');return}
    setAuth('');setAccountId('');setSummary(null);setCategories([]);setTrends([]);setTransactions({items:[],totalElements:0,totalPages:0})
    api.get(`/accounts/customer/${customerId}`).then(({data})=>setAccounts(data)).catch(e=>setError(message(e)))
    api.post('/session',{customerId}).then(({data})=>setAuth(data.token)).catch(e=>setError(message(e)))
  },[customerId])
  const reload = useCallback(async () => {
    if (!auth || !accountId) return
    setLoading(true);setError('')
    try {
      const base=`/aggregation/accounts/${accountId}`
      const options=secured(auth)
      const [a,b,c,d]=await Promise.all([
        api.get(`${base}/summary`,{...options,params:period}),
        api.get(`${base}/categories`,{...options,params:period}),
        api.get(`${base}/trends`,{...options,params:{...period,granularity:'DAY'}}),
        api.get('/aggregation/transactions',{...options,params:{...period,...filters,accountId,size:20}}),
      ])
      setSummary(a.data);setCategories(b.data);setTrends(c.data);setTransactions(d.data)
    }catch(e){setError(message(e))} finally{setLoading(false)}
  },[accountId,auth,period,filters,secured])
  useEffect(()=>{reload()},[reload])
  const createCustomer = async (event) => {
    event.preventDefault();setError('');setNotice('')
    try {
      const {data}=await api.post('/customers',{...customerForm,clientType:'INDIVIDUAL'})
      await loadCustomers();setCustomerId(data.id);setNotice('Customer created')
    }catch(e){setError(message(e))}
  }
  const createAccount = async () => {
    setError('');try {
      const {data}=await api.post('/accounts',{customerId,accountType:'SAVINGS'})
      const list=await api.get(`/accounts/customer/${customerId}`);setAccounts(list.data);setAccountId(data.id);setNotice('Account created')
    }catch(e){setError(message(e))}
  }
  const runImport = async (event) => {
    event.preventDefault();setLoading(true);setError('');setNotice('')
    try {
      const {data}=await api.post('/aggregation/imports',{...importOptions,accountId,...period,count:Number(importOptions.count),seed:Number(importOptions.seed)},secured(auth))
      setNotice(`Imported ${data.received} rows: ${data.counted} counted, ${data.duplicatesSkipped} duplicates, ${data.failed} failed`)
      await reload()
    }catch(e){setError(message(e))}finally{setLoading(false)}
  }
  return <div className="layout">
    <aside className="sidebar"><div className="brand"><Layers3 size={25}/> Transaction<span>Hub</span></div>
      <div className="side-heading">WORKSPACE</div><div className="side-active"><Activity size={17}/> Aggregation overview</div>
      <div className="side-heading">ARCHITECTURE</div><p>Multiple mock sources → normalisation → categorisation → PostgreSQL</p><p>Kafka streams transaction events and powers asynchronous integration.</p>
      <div className="sidebar-bottom">FULL STACK · JAVA / REACT / KAFKA</div></aside>
    <main className="content"><header className="topbar"><div><small>TRANSACTION AGGREGATION API</small><h1>Financial overview</h1><p>Multi-source transaction intelligence in one place.</p></div><button className="secondary" onClick={reload} disabled={!accountId||loading}><RefreshCcw size={16}/> Refresh</button></header>
      {error&&<div role="alert" className="alert danger">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}
      <section className="panel"><div className="panel-title"><h2>Workspace setup</h2><span>Demo customer &amp; account records</span></div>
        <div className="setup-grid"><label>Customer<select value={customerId} onChange={e=>setCustomerId(e.target.value)}><option value="">Choose customer</option>{customers.map(c=><option key={c.id} value={c.id}>{c.firstName} {c.lastName} · {c.email}</option>)}</select></label>
          <label>Account<select value={accountId} onChange={e=>setAccountId(e.target.value)} disabled={!customerId}><option value="">Choose account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.accountNumber} · {a.accountType}</option>)}</select></label>
          <button onClick={createAccount} disabled={!customerId}>+ Create savings account</button></div>
        <details><summary>New demo customer</summary><form onSubmit={createCustomer} className="setup-grid"><input required placeholder="First name" value={customerForm.firstName} onChange={e=>setCustomerForm({...customerForm,firstName:e.target.value})}/><input required placeholder="Last name" value={customerForm.lastName} onChange={e=>setCustomerForm({...customerForm,lastName:e.target.value})}/><input type="email" required placeholder="Email" value={customerForm.email} onChange={e=>setCustomerForm({...customerForm,email:e.target.value})}/><button>Create customer</button></form></details>
      </section>
      <section className="panel"><div className="panel-title"><h2>Ingest mock transactions</h2><span>Repeatable seeded data from independent adapters</span></div><form className="import-grid" onSubmit={runImport}><label>Source<select value={importOptions.source} onChange={e=>setImportOptions({...importOptions,source:e.target.value})}>{sources.map(x=><option key={x} value={x}>{readable(x)}</option>)}</select></label><label>Records<input type="number" min="1" max="2000" required value={importOptions.count} onChange={e=>setImportOptions({...importOptions,count:e.target.value})}/></label><label>Seed<input type="number" required value={importOptions.seed} onChange={e=>setImportOptions({...importOptions,seed:e.target.value})}/></label><label>From<input type="date" required value={period.from} onChange={e=>setPeriod({...period,from:e.target.value})}/></label><label>To<input type="date" required value={period.to} onChange={e=>setPeriod({...period,to:e.target.value})}/></label><button disabled={!accountId||!auth||loading}>{loading?'Loading…':'Import source'}</button></form></section>
      <div className="metrics"><article className="metric"><span>Transactions</span><b>{summary?.transactionCount??'—'}</b><small>Counted, deduplicated</small></article><article className="metric"><span>Credits <ArrowDownLeft size={15}/></span><b>{summary?currency(summary.creditTotal):'—'}</b><small>{summary?.creditCount??0} transactions</small></article><article className="metric"><span>Debits <ArrowUpRight size={15}/></span><b>{summary?currency(summary.debitTotal):'—'}</b><small>{summary?.debitCount??0} transactions</small></article><article className="metric"><span>Net flow</span><b>{summary?currency(summary.netTotal):'—'}</b><small>Selected time period</small></article></div>
      <div className="two-col"><section className="panel"><div className="panel-title"><h2>Category breakdown</h2><span>Counted transactions only</span></div>{categories.length?categories.slice(0,12).map((c,i)=><div className="category" key={`${c.category}-${c.direction}`}><span>{readable(c.category)}</span><div className="bar"><span style={{width:`${Math.max(3,100*Number(c.total)/Math.max(...categories.map(x=>Number(x.total)),1))}%`}}/></div><b>{currency(c.total)}</b></div>):<p className="muted">Import data to see category breakdown.</p>}</section>
      <section className="panel"><div className="panel-title"><h2>Daily net trend</h2><span>{trends.length} days</span></div>{trends.length?<div className="trend">{trends.slice(-30).map(t=><div key={t.period} title={`${t.period}: ${currency(t.netTotal)}`} className="trend-item"><span style={{height:`${Math.max(3,Math.min(100,50+Number(t.netTotal)/Math.max(...trends.map(x=>Math.abs(Number(x.netTotal))),1)*45))}%`}}/></div>)}</div>:<p className="muted">No activity for selected dates.</p>}</section></div>
      <section className="panel"><div className="panel-title"><h2>Aggregated transactions</h2><span>{transactions.totalElements} records · page {filters.page+1}</span></div><div className="filter-row"><select aria-label="Direction filter" value={filters.direction} onChange={e=>setFilters({...filters,direction:e.target.value,page:0})}><option value="">All directions</option><option value="CREDIT">Credit</option><option value="DEBIT">Debit</option></select><input placeholder="Category filter e.g. GROCERIES" aria-label="Category filter" value={filters.category} onChange={e=>setFilters({...filters,category:e.target.value,page:0})}/></div><div className="table-scroll"><table><thead><tr><th>Date</th><th>Source</th><th>Category</th><th>Direction</th><th>Status</th><th>Amount</th></tr></thead><tbody>{transactions.items.map(t=><tr key={t.id}><td>{t.occurredAt?.replace('T',' ').slice(0,16)}</td><td>{readable(t.source)}</td><td>{readable(t.category)}</td><td>{t.direction}</td><td>{t.counted?'COUNTED':'DUPLICATE'}</td><td className="money">{currency(t.amount)}</td></tr>)}</tbody></table>{!transactions.items.length&&<p className="muted">No transactions match this selection.</p>}</div><div className="pagination"><button className="secondary" disabled={filters.page===0} onClick={()=>setFilters({...filters,page:filters.page-1})}>Previous</button><button className="secondary" disabled={filters.page+1>=transactions.totalPages} onClick={()=>setFilters({...filters,page:filters.page+1})}>Next</button></div></section>
      <footer className="footer"><Database size={15}/> Spring Boot · React · PostgreSQL · Apache Kafka · Mock sources</footer>
    </main></div>
}
