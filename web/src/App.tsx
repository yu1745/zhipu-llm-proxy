import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import {
  Pulse as Activity, Archive as ArchiveBox, ArrowClockwise, Check, Clipboard, Database, Eye, EyeSlash,
  Gauge, HardDrives, Key, List, LockKey, Plus, SignOut, SpinnerGap, WarningCircle, X,
} from '@phosphor-icons/react'

const API = 'api/'
type Json = Record<string, unknown>
type Session = { csrfToken: string }
type View = 'overview' | 'keys' | 'archives'
type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T }

class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }

async function request(path: string, init: RequestInit = {}, csrf?: string) {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const response = await fetch(API + path, { ...init, headers, credentials: 'include' })
  const text = await response.text()
  let body: unknown = null
  if (text) { try { body = JSON.parse(text) } catch { body = text } }
  if (!response.ok) {
    const obj = asObject(body)
    throw new ApiError(response.status, String(obj.message ?? obj.error ?? `Request failed (${response.status})`))
  }
  return body
}
function asObject(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {} }
function arrayFrom(value: unknown, ...keys: string[]) {
  if (Array.isArray(value)) return value
  const obj = asObject(value)
  for (const key of keys) if (Array.isArray(obj[key])) return obj[key] as unknown[]
  return []
}
function pick(obj: Json, paths: string[], fallback: unknown = '—'): unknown {
  for (const path of paths) {
    let value: unknown = obj
    for (const part of path.split('.')) value = asObject(value)[part]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return fallback
}
function text(value: unknown) { return typeof value === 'string' ? value : value == null ? '' : String(value) }
function display(value: unknown) {
  if (typeof value === 'boolean') return value ? 'Online' : 'Offline'
  if (typeof value === 'number') return value.toLocaleString()
  return text(value) || '—'
}
function formatDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(text(value)); return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString()
}
function formatBytes(value: unknown) {
  const n = Number(value); if (!Number.isFinite(n)) return display(value)
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}
function extractSession(value: unknown): Session | null {
  const obj = asObject(value); const token = pick(obj, ['csrfToken', 'csrf_token', 'csrf'], '')
  const authenticated = pick(obj, ['authenticated', 'loggedIn', 'valid'], true)
  return authenticated !== false && token ? { csrfToken: text(token) } : null
}

export function App() {
  return window.location.pathname.includes('/zhipu-proxy/portal') ? <UserPortalApp /> : <AdminApp />
}

function AdminApp() {
  const [session, setSession] = useState<Load<Session | null>>({ state: 'loading' })
  const verify = useCallback(async () => {
    setSession({ state: 'loading' })
    try { setSession({ state: 'ready', data: extractSession(await request('session')) }) }
    catch (error) { if (error instanceof ApiError && error.status === 401) setSession({ state: 'ready', data: null }); else setSession({ state: 'error', message: errorMessage(error) }) }
  }, [])
  useEffect(() => { void verify() }, [verify])
  if (session.state === 'loading') return <FullLoader label="Checking secure session" />
  if (session.state === 'error') return <FatalState message={session.message} retry={verify} />
  if (!session.data) return <Login onLogin={(s) => setSession({ state: 'ready', data: s })} />
  return <Dashboard session={session.data} onExpired={() => setSession({ state: 'ready', data: null })} />
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [visible, setVisible] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!password || busy) return
    setBusy(true); setError('')
    try {
      const loginBody = await request('login', { method: 'POST', body: JSON.stringify({ password }) })
      const found = extractSession(loginBody) ?? extractSession(await request('session'))
      if (!found) throw new Error('The server did not establish a valid session.')
      setPassword(''); onLogin(found)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <main className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1.2fr)_minmax(380px,.8fr)]">
    <section className="hidden border-r border-line p-12 lg:flex lg:flex-col lg:justify-between">
      <Brand />
      <div className="max-w-xl animate-enter">
        <p className="eyebrow mb-4">Secure operations console</p>
        <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.045em]">Control the proxy.<br/><span className="text-muted">Protect the path.</span></h1>
        <p className="mt-6 max-w-[52ch] text-base leading-relaxed text-muted">A focused workspace for service health, access credentials, and request archive inspection.</p>
      </div>
      <p className="text-xs text-muted">Zhipu Proxy / Administration</p>
    </section>
    <section className="flex min-h-[100dvh] items-center justify-center p-5 sm:p-10">
      <div className="w-full max-w-md animate-enter">
        <div className="mb-12 lg:hidden"><Brand /></div>
        <p className="eyebrow">Restricted access</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">Sign in to continue</h2>
        <p className="mt-2 text-sm text-muted">Use the administrator password configured on this host.</p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <div className="space-y-2"><label htmlFor="password" className="text-sm font-medium">Administrator password</label>
            <div className="relative"><input id="password" autoFocus autoComplete="current-password" className="field pr-11" type={visible ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} aria-invalid={!!error}/>
              <button type="button" onClick={() => setVisible(v => !v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted outline-none hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeSlash size={18}/> : <Eye size={18}/>}</button></div>
            {error && <p role="alert" className="flex items-center gap-2 text-sm text-[#e89a80]"><WarningCircle size={16}/>{error}</p>}
          </div>
          <button className="button-primary w-full" disabled={busy || !password}>{busy ? <><SpinnerGap className="animate-spin"/>Authenticating</> : <><LockKey/>Open console</>}</button>
        </form>
      </div>
    </section>
  </main>
}

function Dashboard({ session, onExpired }: { session: Session; onExpired: () => void }) {
  const [view, setView] = useState<View>('overview'); const [loggingOut, setLoggingOut] = useState(false)
  async function logout() { setLoggingOut(true); try { await request('logout', { method: 'POST' }, session.csrfToken) } finally { onExpired() } }
  return <div className="min-h-[100dvh]">
    <header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-6"><Brand compact/>
        <div className="flex items-center gap-3"><span className="hidden items-center gap-2 text-xs text-muted sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#8fa477]"/>Session protected</span><button onClick={logout} disabled={loggingOut} className="button-secondary" aria-label="Sign out">{loggingOut ? <SpinnerGap className="animate-spin"/> : <SignOut/>}<span className="hidden sm:inline">Sign out</span></button></div>
      </div>
    </header>
    <div className="mx-auto grid max-w-[1400px] md:grid-cols-[210px_minmax(0,1fr)]">
      <nav className="border-b border-line p-3 md:min-h-[calc(100dvh-4rem)] md:border-b-0 md:border-r md:p-4" aria-label="Primary">
        <div className="flex gap-1 md:flex-col">{([['overview', Gauge, 'Overview'], ['keys', Key, 'Credentials'], ['archives', ArchiveBox, 'Archives']] as const).map(([id, Icon, label]) => <button key={id} onClick={() => setView(id)} className={`flex flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:flex-none ${view === id ? 'bg-accent/15 text-[#eb9678]' : 'text-muted hover:bg-white/[.04] hover:text-paper'}`}><Icon size={18}/><span>{label}</span></button>)}</div>
      </nav>
      <main className="min-w-0 p-4 sm:p-6 lg:p-9">{view === 'overview' && <Overview/>}{view === 'keys' && <Credentials csrf={session.csrfToken}/>} {view === 'archives' && <Archives/>}</main>
    </div>
  </div>
}

function Overview() {
  const [result, reload] = useResource<Json>('status')
  return <Page title="Operational overview" subtitle="Live service signals and host capacity." action={<Refresh onClick={reload} loading={result.state === 'loading'}/>}>
    {result.state === 'loading' && <MetricSkeleton/>}
    {result.state === 'error' && <ErrorState message={result.message} retry={reload}/>}
    {result.state === 'ready' && <StatusContent data={result.data}/>}
  </Page>
}
function StatusContent({ data }: { data: Json }) {
  const usage = asObject(pick(data, ['usage'], {}))
  const metrics = [
    { label: 'Service', value: pick(data, ['service.status','service','status']), icon: Activity, detail: pick(data, ['service.uptime','uptime'], 'Runtime status') },
    { label: 'Tailscale', value: pick(data, ['tailscale.status','tailscale.connected','tailscale']), icon: Gauge, detail: pick(data, ['tailscale.ip','tailscale.address','tailscale.hostname'], 'Network path') },
    { label: 'Archives', value: pick(data, ['archives.count','archive_count','archiveCount','archives']), icon: Database, detail: pick(data, ['archives.size','archive_size','archiveSize'], 'Recorded requests') },
    { label: 'Disk available', value: formatBytes(pick(data, ['disk.available','disk.free','disk_free','diskFree'])), icon: HardDrives, detail: `${display(pick(data, ['disk.used_percent','disk.usedPercent'], '—'))}${pick(data, ['disk.used_percent','disk.usedPercent'], null) !== null ? '% used' : 'Host storage'}` },
  ]
  return <div className="animate-enter"><div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">{metrics.map(({label,value,icon:Icon,detail}) => <section key={label} className="bg-panel p-5"><div className="flex items-center justify-between"><p className="eyebrow">{label}</p><Icon className="text-muted" size={20}/></div><p className="mt-5 truncate text-2xl font-semibold tracking-tight">{display(value)}</p><p className="mt-1 truncate text-xs text-muted">{display(detail)}</p></section>)}</div>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">Global usage</p><h3 className="mt-2 font-semibold">Token consumption</h3></div><Activity className="text-muted" size={20}/></div><div className="mt-5 grid gap-4 sm:grid-cols-3">{[['Prompt',pick(usage,['prompt_tokens'])],['Completion',pick(usage,['completion_tokens'])],['Total',pick(usage,['total_tokens'])]].map(([label,value])=><div key={text(label)} className="border-t border-line pt-3"><p className="text-xs text-muted">{display(label)} tokens</p><p className="mt-1 text-xl font-semibold">{display(value)}</p></div>)}</div></section>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#8fa477]"/><h3 className="font-semibold">System response</h3></div><p className="mt-2 text-sm text-muted">Status endpoint responded successfully. Updated {new Date().toLocaleTimeString()}.</p></section></div>
}

function Credentials({ csrf }: { csrf: string }) {
  const [keys, reload] = useResource<unknown>('client-keys'); const [upstream, reloadUpstream] = useResource<unknown>('upstream-key')
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [revealed, setRevealed] = useState(''); const [copied, setCopied] = useState(false)
  const [upstreamValue, setUpstreamValue] = useState(''); const [showUpstream, setShowUpstream] = useState(false)
  const rows = keys.state === 'ready' ? arrayFrom(keys.data, 'keys', 'items', 'data') : []
  async function generate() { setBusy('generate'); setError(''); try { const body = await request('client-keys', { method:'POST', body: '{}' }, csrf); const obj = asObject(body); setRevealed(text(pick(obj, ['key','clientKey','client_key','token'], ''))); reload() } catch(e) { setError(errorMessage(e)) } finally { setBusy('') } }
  async function remove(id: string) { if (!window.confirm('Revoke this client key? Existing clients using it will lose access.')) return; setBusy(id); setError(''); try { await request(`client-keys?id=${encodeURIComponent(id)}`, { method:'DELETE' }, csrf); reload() } catch(e) { setError(errorMessage(e)) } finally { setBusy('') } }
  async function saveUpstream(e: FormEvent) { e.preventDefault(); if (!upstreamValue) return; setBusy('upstream'); setError(''); try { await request('upstream-key', { method:'PUT', body: JSON.stringify({ key: upstreamValue }) }, csrf); setUpstreamValue(''); reloadUpstream() } catch(err) { setError(errorMessage(err)) } finally { setBusy('') } }
  async function copyKey() { try { await navigator.clipboard.writeText(revealed); setCopied(true); window.setTimeout(() => setCopied(false), 1800) } catch { setError('Clipboard access was denied. Select and copy the key manually.') } }
  return <Page title="Credentials" subtitle="Manage downstream access and the upstream provider key." action={<button onClick={generate} disabled={!!busy} className="button-primary"><Plus/>Generate key</button>}>
    {error && <InlineAlert message={error}/>} {revealed && <section aria-live="polite" className="mb-6 rounded-lg border border-accent/40 bg-accent/10 p-5 animate-enter"><div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-[#ed9c80]">Copy this key now</p><p className="mt-1 text-sm text-muted">It will not be shown again after you dismiss this message.</p></div><button onClick={() => setRevealed('')} className="rounded p-1 text-muted hover:text-paper" aria-label="Dismiss"><X/></button></div><div className="mt-4 flex flex-col gap-2 sm:flex-row"><code className="min-w-0 flex-1 overflow-x-auto rounded bg-ink p-3 font-mono text-sm">{revealed}</code><button onClick={copyKey} className="button-secondary">{copied ? <Check/> : <Clipboard/>}{copied ? 'Copied' : 'Copy'}</button></div></section>}
    <section className="surface overflow-hidden rounded-lg"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h3 className="font-semibold">Client keys</h3><p className="mt-1 text-xs text-muted">Keys authorized to call the proxy</p></div><span className="rounded bg-white/[.05] px-2 py-1 text-xs text-muted">{rows.length} total</span></div>
      {keys.state === 'loading' ? <ListSkeleton/> : keys.state === 'error' ? <ErrorState message={keys.message} retry={reload}/> : rows.length === 0 ? <EmptyState icon={<Key/>} title="No client keys" body="Generate a key to authorize your first client."/> : <div className="divide-y divide-line">{rows.map((raw, index) => { const row = asObject(raw); const id = text(pick(row,['id','key_id','keyId'], String(index))); return <div key={id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><p className="truncate font-mono text-sm">{display(pick(row,['masked','key','prefix','name'], `Key ${index + 1}`))}</p><p className="mt-1 text-xs text-muted">Created {formatDate(pick(row,['created_at','createdAt','created']))}</p></div><button onClick={() => remove(id)} disabled={busy === id} className="button-secondary text-[#e89a80]">{busy === id ? <SpinnerGap className="animate-spin"/> : <X/>}Revoke</button></div>})}</div>}
    </section>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]"><div><p className="eyebrow">Provider credential</p><h3 className="mt-2 font-semibold">Upstream API key</h3><p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted">Replace the credential used for upstream requests. The current value remains masked and is never stored in this browser.</p>{upstream.state === 'ready' && <p className="mt-4 font-mono text-sm">Current: {display(pick(asObject(upstream.data), ['masked','key','value'], 'Configured'))}</p>}{upstream.state === 'error' && <p className="mt-3 text-sm text-[#e89a80]">{upstream.message}</p>}</div>
      <form onSubmit={saveUpstream} className="space-y-2"><label htmlFor="upstream" className="text-sm font-medium">New upstream key</label><div className="relative"><input id="upstream" className="field pr-11" type={showUpstream?'text':'password'} autoComplete="off" value={upstreamValue} onChange={e=>setUpstreamValue(e.target.value)} placeholder="Enter replacement key"/><button type="button" onClick={()=>setShowUpstream(v=>!v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted hover:text-paper" aria-label="Toggle key visibility">{showUpstream?<EyeSlash/>:<Eye/>}</button></div><button className="button-primary mt-2 w-full" disabled={!upstreamValue||busy==='upstream'}>{busy==='upstream'?<SpinnerGap className="animate-spin"/>:<Key/>}Update upstream key</button></form></div></section>
  </Page>
}

function Archives() {
  const [cursor, setCursor] = useState(''); const [selected, setSelected] = useState<Json|null>(null); const [refreshKey, setRefreshKey] = useState(0)
  const [result, setResult] = useState<Load<unknown>>({state:'loading'})
  const load = useCallback(async () => { setResult({state:'loading'}); try { setResult({state:'ready',data:await request(`archives?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)}) } catch(e){ setResult({state:'error',message:errorMessage(e)}) } },[cursor,refreshKey])
  useEffect(()=>{void load()},[load]); const obj=result.state==='ready'?asObject(result.data):{}; const rows=result.state==='ready'?arrayFrom(result.data,'archives','items','data'):[]; const next=text(pick(obj,['next_cursor','nextCursor','cursor'],''))
  if(selected) return <ArchiveDetail archive={selected} onBack={()=>setSelected(null)}/>
  return <Page title="Request archives" subtitle="Inspect captured request and response exchanges." action={<Refresh onClick={()=>setRefreshKey(k=>k+1)} loading={result.state==='loading'}/>}>{result.state==='loading'?<ListSkeleton rows={7}/>:result.state==='error'?<ErrorState message={result.message} retry={load}/>:rows.length===0?<EmptyState icon={<ArchiveBox/>} title="No archived requests" body="Captured traffic will appear here when archive recording is enabled."/>:<><div className="surface overflow-hidden rounded-lg"><div className="hidden grid-cols-[1fr_110px_150px_190px] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted md:grid"><span>Request</span><span>Status</span><span>Duration</span><span>Time</span></div><div className="divide-y divide-line">{rows.map((raw,index)=>{const row=asObject(raw);return <button key={text(pick(row,['id','archive_id'],index))} onClick={()=>setSelected(row)} className="grid w-full gap-2 px-5 py-4 text-left outline-none transition hover:bg-white/[.025] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:grid-cols-[1fr_110px_150px_190px] md:items-center md:gap-4"><div className="min-w-0"><p className="truncate text-sm font-medium">{display(pick(row,['method'],'POST'))} <span className="text-muted">{display(pick(row,['request_uri','path','url','endpoint'],pick(row,['id'],'Request')))}</span></p><p className="mt-1 truncate font-mono text-xs text-muted">{display(pick(row,['id','archive_id']))}</p></div><span className="text-sm">{display(pick(row,['response_status','status','status_code','statusCode']))}</span><span className="text-sm text-muted">{display(pick(row,['duration','duration_ms','durationMs']))}{pick(row,['duration_ms','durationMs'],null)!==null?' ms':''}</span><span className="text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp','time']))}</span></button>})}</div></div>{next&&<div className="mt-4 flex justify-end"><button className="button-secondary" onClick={()=>setCursor(next)}>Load next page</button></div>}</>}
  </Page>
}

function ArchiveDetail({ archive, onBack }: { archive: Json; onBack:()=>void }) {
  const id=text(pick(archive,['id','archive_id'])); const [detail]=useResource<Json>(`archives/${encodeURIComponent(id)}`); const [req]=useResource<unknown>(`archives/${encodeURIComponent(id)}/request`); const [res]=useResource<unknown>(`archives/${encodeURIComponent(id)}/response`)
  const data=detail.state==='ready'?{...archive,...detail.data}:archive
  return <Page title="Archive detail" subtitle={id} action={<button className="button-secondary" onClick={onBack}><List/>Back to archives</button>}>
    <div className="mb-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">{[['Method',pick(data,['method'])],['Status',pick(data,['response_status','status','status_code','statusCode'])],['Duration',pick(data,['duration','duration_ms','durationMs'])],['Captured',formatDate(pick(data,['started_at','created_at','createdAt','timestamp','time']))]].map(([label,value])=><div key={text(label)} className="bg-panel p-4"><p className="eyebrow">{display(label)}</p><p className="mt-2 truncate text-sm font-semibold">{display(value)}</p></div>)}</div>
    {detail.state==='error'&&<InlineAlert message={detail.message}/>}<div className="grid gap-6 xl:grid-cols-2"><BodyPanel title="Request" value={req}/><BodyPanel title="Response" value={res}/></div>
  </Page>
}
function BodyPanel({title,value}:{title:string;value:Load<unknown>}) { return <section className="surface min-w-0 overflow-hidden rounded-lg"><div className="border-b border-line px-5 py-4"><h3 className="font-semibold">{title}</h3></div>{value.state==='loading'?<div className="space-y-2 p-5"><div className="skeleton h-4 w-3/4"/><div className="skeleton h-4 w-full"/><div className="skeleton h-4 w-2/3"/></div>:value.state==='error'?<div className="p-5 text-sm text-[#e89a80]">{value.message}</div>:<pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-relaxed text-[#d8d4ca]">{pretty(value.data)}</pre>}</section> }
function pretty(value:unknown){if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2)}catch{return value||'(empty body)'}}try{return JSON.stringify(value,null,2)}catch{return String(value)}}

function useResource<T=unknown>(path:string):[Load<T>,()=>void]{const [result,setResult]=useState<Load<T>>({state:'loading'});const [tick,setTick]=useState(0);useEffect(()=>{let active=true;setResult({state:'loading'});request(path).then(data=>{if(active)setResult({state:'ready',data:data as T})}).catch(e=>{if(active)setResult({state:'error',message:errorMessage(e)})});return()=>{active=false}},[path,tick]);return[result,()=>setTick(v=>v+1)]}
function Page({title,subtitle,action,children}:{title:string;subtitle:string;action?:ReactNode;children:ReactNode}){return <div className="animate-enter"><div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow">Administration</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1><p className="mt-2 text-sm text-muted">{subtitle}</p></div>{action&&<div className="shrink-0">{action}</div>}</div>{children}</div>}
function Brand({compact=false}:{compact?:boolean}){return <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded bg-accent text-ink"><Activity weight="bold"/></span><div><p className="text-sm font-semibold leading-none">Zhipu Proxy</p>{!compact&&<p className="mt-1 text-[10px] uppercase tracking-[.18em] text-muted">Operations</p>}</div></div>}
function Refresh({onClick,loading}:{onClick:()=>void;loading:boolean}){return <button className="button-secondary" onClick={onClick} disabled={loading}><ArrowClockwise className={loading?'animate-spin':''}/>Refresh</button>}
function FullLoader({label}:{label:string}){return <main className="grid min-h-[100dvh] place-items-center p-6"><div className="text-center"><SpinnerGap size={28} className="mx-auto animate-spin text-accent"/><p className="mt-4 text-sm text-muted">{label}</p></div></main>}
function FatalState({message,retry}:{message:string;retry:()=>void}){return <main className="grid min-h-[100dvh] place-items-center p-6"><div className="max-w-md text-center"><WarningCircle className="mx-auto text-accent" size={34}/><h1 className="mt-4 text-xl font-semibold">Console unavailable</h1><p className="mt-2 text-sm text-muted">{message}</p><button onClick={retry} className="button-primary mt-6">Try again</button></div></main>}
function ErrorState({message,retry}:{message:string;retry:()=>void}){return <div className="surface rounded-lg p-8 text-center"><WarningCircle className="mx-auto text-accent" size={30}/><h3 className="mt-3 font-semibold">Unable to load data</h3><p className="mt-2 text-sm text-muted">{message}</p><button onClick={retry} className="button-secondary mt-5">Try again</button></div>}
function EmptyState({icon,title,body}:{icon:ReactNode;title:string;body:string}){return <div className="surface rounded-lg p-10 text-center"><div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white/[.05] text-muted">{icon}</div><h3 className="mt-4 font-semibold">{title}</h3><p className="mt-2 text-sm text-muted">{body}</p></div>}
function InlineAlert({message}:{message:string}){return <div role="alert" className="mb-5 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 p-3 text-sm text-[#ed9c80]"><WarningCircle className="mt-0.5 shrink-0"/>{message}</div>}
function MetricSkeleton(){return <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map(i=><div key={i} className="space-y-5 bg-panel p-5"><div className="skeleton h-3 w-20"/><div className="skeleton h-7 w-28"/><div className="skeleton h-3 w-24"/></div>)}</div>}
function ListSkeleton({rows=4}:{rows?:number}){return <div className="surface divide-y divide-line overflow-hidden rounded-lg">{Array.from({length:rows},(_,i)=><div key={i} className="space-y-2 p-5"><div className="skeleton h-4 w-2/5"/><div className="skeleton h-3 w-1/4"/></div>)}</div>}
function UserPortalApp() {
  const [session, setSession] = useState<Load<Session | null>>({ state: 'loading' })
  const verify = useCallback(async () => {
    setSession({ state: 'loading' })
    try {
      setSession({ state: 'ready', data: extractSession(await request('user-session')) })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setSession({ state: 'ready', data: null })
      else setSession({ state: 'error', message: errorMessage(error) })
    }
  }, [])
  useEffect(() => { void verify() }, [verify])
  if (session.state === 'loading') return <FullLoader label="Checking client session" />
  if (session.state === 'error') return <FatalState message={session.message} retry={verify} />
  if (!session.data) return <UserLogin onLogin={(s) => setSession({ state: 'ready', data: s })} />
  return <UserDashboard session={session.data} onLogout={() => setSession({ state: 'ready', data: null })} />
}

function UserLogin({ onLogin }: { onLogin: (session: Session) => void }) {
  const [key, setKey] = useState(''); const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); if (!key || busy) return; setBusy(true); setError(''); try { const session = extractSession(await request('user-login', { method: 'POST', body: JSON.stringify({ key }) })); if (!session) throw new Error('Invalid session response'); setKey(''); onLogin(session) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) } }
  return <main className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1fr)_minmax(380px,.8fr)]">
    <section className="hidden border-r border-line p-12 lg:flex lg:flex-col lg:justify-between"><Brand/><div className="max-w-xl animate-enter"><p className="eyebrow mb-4">Client portal</p><h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.045em]">Your traffic.<br/><span className="text-muted">Clearly accounted.</span></h1><p className="mt-6 max-w-[52ch] leading-relaxed text-muted">Review token consumption, model activity, and your recent proxy requests.</p></div><p className="text-xs text-muted">Zhipu Proxy / Client access</p></section>
    <section className="flex min-h-[100dvh] items-center justify-center p-5 sm:p-10"><div className="w-full max-w-md animate-enter"><div className="mb-12 lg:hidden"><Brand/></div><p className="eyebrow">Client access</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">Open your usage portal</h2><p className="mt-2 text-sm text-muted">Authenticate with your issued client API key.</p><form onSubmit={submit} className="mt-8 space-y-5"><div className="space-y-2"><label htmlFor="client-key" className="text-sm font-medium">Client API key</label><div className="relative"><input id="client-key" autoFocus autoComplete="off" className="field pr-11" type={visible?'text':'password'} value={key} onChange={e=>setKey(e.target.value)}/><button type="button" onClick={()=>setVisible(v=>!v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted hover:text-paper" aria-label={visible?'Hide key':'Show key'}>{visible?<EyeSlash/>:<Eye/>}</button></div>{error&&<p role="alert" className="flex items-center gap-2 text-sm text-[#e89a80]"><WarningCircle/>{error}</p>}</div><button className="button-primary w-full" disabled={!key||busy}>{busy?<SpinnerGap className="animate-spin"/>:<LockKey/>}{busy?'Authenticating':'View my usage'}</button></form><p className="mt-6 text-xs leading-relaxed text-muted">Your key is sent only to authenticate this session and is never stored in browser storage.</p></div></section>
  </main>
}

function UserDashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [view, setView] = useState<'usage'|'requests'>('usage'); const [busy,setBusy]=useState(false)
  async function logout(){setBusy(true);try{await request('user-logout',{method:'POST'},session.csrfToken)}finally{onLogout()}}
  return <div className="min-h-[100dvh]"><header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-6"><Brand compact/><div className="flex items-center gap-3"><span className="hidden text-xs text-muted sm:inline">Client portal</span><button className="button-secondary" onClick={logout} disabled={busy}>{busy?<SpinnerGap className="animate-spin"/>:<SignOut/>}<span className="hidden sm:inline">Sign out</span></button></div></div></header><div className="mx-auto grid max-w-[1400px] md:grid-cols-[210px_minmax(0,1fr)]"><nav className="border-b border-line p-3 md:min-h-[calc(100dvh-4rem)] md:border-b-0 md:border-r md:p-4"><div className="flex gap-1 md:flex-col"><PortalNav active={view==='usage'} onClick={()=>setView('usage')} icon={<Gauge/>} label="My usage"/><PortalNav active={view==='requests'} onClick={()=>setView('requests')} icon={<ArchiveBox/>} label="My requests"/></div></nav><main className="min-w-0 p-4 sm:p-6 lg:p-9">{view==='usage'?<UserUsage onRequests={()=>setView('requests')}/>:<UserArchives/>}</main></div></div>
}
function PortalNav({active,onClick,icon,label}:{active:boolean;onClick:()=>void;icon:ReactNode;label:string}){return <button onClick={onClick} className={`flex flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:flex-none ${active?'bg-accent/15 text-[#eb9678]':'text-muted hover:bg-white/[.04] hover:text-paper'}`}>{icon}{label}</button>}

function UserUsage({onRequests}:{onRequests:()=>void}) {
  const [result,reload]=useResource<Json>('user-usage')
  return <Page title="My usage" subtitle="Token consumption and model activity for this client key." action={<Refresh onClick={reload} loading={result.state==='loading'}/>}>{result.state==='loading'?<MetricSkeleton/>:result.state==='error'?<ErrorState message={result.message} retry={reload}/>:<UserUsageContent data={result.data} onRequests={onRequests}/>}</Page>
}
function UserUsageContent({data,onRequests}:{data:Json;onRequests:()=>void}){
  const metrics=[['Requests',pick(data,['request_count','requestCount','requests'])],['Prompt tokens',pick(data,['prompt_tokens','promptTokens','tokens.prompt'])],['Completion tokens',pick(data,['completion_tokens','completionTokens','tokens.completion'])],['Total tokens',pick(data,['total_tokens','totalTokens','tokens.total'])]]
  const distRaw=pick(data,['model_distribution','modelDistribution','models'],{}); const distribution=Array.isArray(distRaw)?distRaw.map(asObject):Object.entries(asObject(distRaw)).map(([model,count])=>({model,count})); const max=Math.max(1,...distribution.map(r=>Number(pick(r,['count','requests','value'],0))))
  const recent=arrayFrom(pick(data,['recent_requests','recentRequests','recent'],[]),'items')
  return <div className="animate-enter"><div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label,value])=><section key={text(label)} className="bg-panel p-5"><p className="eyebrow">{display(label)}</p><p className="mt-5 text-2xl font-semibold tracking-tight">{display(value)}</p></section>)}</div><div className="mt-6 grid gap-6 lg:grid-cols-[.8fr_1.2fr]"><section className="surface rounded-lg p-5"><h3 className="font-semibold">Model distribution</h3><p className="mt-1 text-xs text-muted">Requests by model</p>{distribution.length===0?<p className="mt-8 text-sm text-muted">No model activity yet.</p>:<div className="mt-6 space-y-4">{distribution.map((row,i)=>{const count=Number(pick(row,['count','requests','value'],0));return <div key={i}><div className="mb-1.5 flex justify-between gap-4 text-sm"><span className="truncate">{display(pick(row,['model','name'],`Model ${i+1}`))}</span><span className="text-muted">{count.toLocaleString()}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-ink"><div className="h-full rounded-full bg-accent" style={{width:`${Math.max(3,count/max*100)}%`}}/></div></div>})}</div>}</section><section className="surface overflow-hidden rounded-lg"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h3 className="font-semibold">Recent requests</h3><p className="mt-1 text-xs text-muted">Latest activity for this key</p></div><button className="text-xs font-semibold text-[#eb9678] hover:text-paper" onClick={onRequests}>View all</button></div>{recent.length===0?<div className="p-8 text-center text-sm text-muted">No requests recorded yet.</div>:<div className="divide-y divide-line">{recent.slice(0,6).map((raw,i)=>{const row=asObject(raw);return <div key={i} className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3"><div className="min-w-0"><p className="truncate text-sm">{display(pick(row,['model','path','endpoint'],'Request'))}</p><p className="mt-1 text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp']))}</p></div><span className="text-sm text-muted">{display(pick(row,['usage.total_tokens','total_tokens','totalTokens','tokens'],'—'))}</span></div>})}</div>}</section></div></div>
}

function UserArchives(){
  const [cursor,setCursor]=useState('');const [selected,setSelected]=useState<Json|null>(null);const path=`user-archives?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;const [result,reload]=useResource<unknown>(path);const obj=result.state==='ready'?asObject(result.data):{};const rows=result.state==='ready'?arrayFrom(result.data,'archives','items','data'):[];const next=text(pick(obj,['next_cursor','nextCursor','cursor'],''));
  if(selected)return <UserArchiveDetail archive={selected} onBack={()=>setSelected(null)}/>
  return <Page title="My requests" subtitle="Request records associated only with this client key." action={<Refresh onClick={reload} loading={result.state==='loading'}/>}>{result.state==='loading'?<ListSkeleton rows={7}/>:result.state==='error'?<ErrorState message={result.message} retry={reload}/>:rows.length===0?<EmptyState icon={<ArchiveBox/>} title="No request records" body="Your proxy requests will appear here."/>:<><div className="surface overflow-hidden rounded-lg"><div className="divide-y divide-line">{rows.map((raw,i)=>{const row=asObject(raw);return <button key={text(pick(row,['id'],i))} onClick={()=>setSelected(row)} className="grid w-full gap-2 px-5 py-4 text-left transition hover:bg-white/[.025] md:grid-cols-[1fr_120px_130px_190px] md:items-center"><div className="min-w-0"><p className="truncate text-sm font-medium">{display(pick(row,['model','path','endpoint'],'Request'))}</p><p className="mt-1 truncate font-mono text-xs text-muted">{display(pick(row,['id']))}</p></div><span className="text-sm">{display(pick(row,['response_status','status','status_code','statusCode']))}</span><span className="text-sm text-muted">{display(pick(row,['usage.total_tokens','total_tokens','totalTokens','tokens']))} tokens</span><span className="text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp']))}</span></button>})}</div></div>{next&&<div className="mt-4 flex justify-end"><button className="button-secondary" onClick={()=>setCursor(next)}>Load next page</button></div>}</>}</Page>
}
function UserArchiveDetail({archive,onBack}:{archive:Json;onBack:()=>void}){const id=text(pick(archive,['id']));const [result]=useResource<unknown>(`user-archives/${encodeURIComponent(id)}`);const [req]=useResource<unknown>(`user-archives/${encodeURIComponent(id)}/request`);const [res]=useResource<unknown>(`user-archives/${encodeURIComponent(id)}/response`);const detail=result.state==='ready'?asObject(result.data):archive;return <Page title="Request detail" subtitle={id} action={<button className="button-secondary" onClick={onBack}><List/>Back to requests</button>}>{result.state==='error'&&<InlineAlert message={result.message}/>}<div className="mb-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">{[['Model',pick(detail,['model'])],['Status',pick(detail,['response_status','status','status_code','statusCode'])],['Total tokens',pick(detail,['usage.total_tokens','total_tokens','totalTokens'])],['Time',formatDate(pick(detail,['started_at','created_at','createdAt','timestamp']))]].map(([label,value])=><div key={text(label)} className="bg-panel p-4"><p className="eyebrow">{display(label)}</p><p className="mt-2 truncate text-sm font-semibold">{display(value)}</p></div>)}</div>{result.state==='loading'?<ListSkeleton rows={4}/>:<div className="grid gap-6 xl:grid-cols-2"><BodyPanel title="Request" value={req}/><BodyPanel title="Response" value={res}/></div>}</Page>}

function errorMessage(error:unknown){return error instanceof Error?error.message:'An unexpected error occurred.'}
