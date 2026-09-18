import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import {
  Pulse as Activity, Archive as ArchiveBox, ArrowClockwise, Check, Clipboard, Code, Database, Eye, EyeSlash,
  Gauge, HardDrives, Key, List, LockKey, Moon, Plus, SignOut, SpinnerGap, Sun, WarningCircle, X,
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
    throw new ApiError(response.status, String(obj.message ?? obj.error ?? `请求失败（${response.status}）`))
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
  if (typeof value === 'boolean') return value ? '在线' : '离线'
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

type Theme = 'dark' | 'light'
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('zhipu-theme')
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('zhipu-theme', theme) }, [theme])
  return [theme, () => setTheme(value => value === 'dark' ? 'light' : 'dark')]
}
function ThemeToggle({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  const next = theme === 'dark' ? '浅色' : '深色'
  return <button type="button" onClick={toggle} className="button-secondary !p-2.5" aria-label={`切换到${next}模式`} title={`切换到${next}模式`}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button>
}

export function App() {
  const [theme, toggleTheme] = useTheme()
  return window.location.pathname.includes('/zhipu-proxy/portal') ? <UserPortalApp theme={theme} toggleTheme={toggleTheme}/> : <AdminApp theme={theme} toggleTheme={toggleTheme}/>
}

function AdminApp({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) {
  const [session, setSession] = useState<Load<Session | null>>({ state: 'loading' })
  const verify = useCallback(async () => {
    setSession({ state: 'loading' })
    try { setSession({ state: 'ready', data: extractSession(await request('session')) }) }
    catch (error) { if (error instanceof ApiError && error.status === 401) setSession({ state: 'ready', data: null }); else setSession({ state: 'error', message: errorMessage(error) }) }
  }, [])
  useEffect(() => { void verify() }, [verify])
  if (session.state === 'loading') return <FullLoader label="正在验证安全会话" />
  if (session.state === 'error') return <FatalState message={session.message} retry={verify} />
  if (!session.data) return <Login theme={theme} toggleTheme={toggleTheme} onLogin={(s) => setSession({ state: 'ready', data: s })} />
  return <Dashboard theme={theme} toggleTheme={toggleTheme} session={session.data} onExpired={() => setSession({ state: 'ready', data: null })} />
}

function Login({ onLogin, theme, toggleTheme }: { onLogin: (session: Session) => void; theme: Theme; toggleTheme: () => void }) {
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [visible, setVisible] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!password || busy) return
    setBusy(true); setError('')
    try {
      const loginBody = await request('login', { method: 'POST', body: JSON.stringify({ password }) })
      const found = extractSession(loginBody) ?? extractSession(await request('session'))
      if (!found) throw new Error('服务器未能建立有效会话。')
      setPassword(''); onLogin(found)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <main className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1.2fr)_minmax(380px,.8fr)]">
    <section className="hidden border-r border-line p-12 lg:flex lg:flex-col lg:justify-between">
      <Brand />
      <div className="max-w-xl animate-enter">
        <p className="eyebrow mb-4">安全运维控制台</p>
        <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.045em]">掌控代理。<br/><span className="text-muted">守护每一次请求。</span></h1>
        <p className="mt-6 max-w-[52ch] text-base leading-relaxed text-muted">集中管理服务状态、访问凭据和请求归档。</p>
      </div>
      <p className="text-xs text-muted">Zhipu Proxy / 管理后台</p>
    </section>
    <section className="relative flex min-h-[100dvh] items-center justify-center p-5 sm:p-10">
      <div className="absolute right-5 top-5"><ThemeToggle theme={theme} toggle={toggleTheme}/></div>
      <div className="w-full max-w-md animate-enter">
        <div className="mb-12 lg:hidden"><Brand /></div>
        <p className="eyebrow">受限访问</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">登录后继续</h2>
        <p className="mt-2 text-sm text-muted">请输入此服务器配置的管理员密码。</p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <div className="space-y-2"><label htmlFor="password" className="text-sm font-medium">管理员密码</label>
            <div className="relative"><input id="password" autoFocus autoComplete="current-password" className="field pr-11" type={visible ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} aria-invalid={!!error}/>
              <button type="button" onClick={() => setVisible(v => !v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted outline-none hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeSlash size={18}/> : <Eye size={18}/>}</button></div>
            {error && <p role="alert" className="flex items-center gap-2 text-sm text-accent"><WarningCircle size={16}/>{error}</p>}
          </div>
          <button className="button-primary w-full" disabled={busy || !password}>{busy ? <><SpinnerGap className="animate-spin"/>正在验证</> : <><LockKey/>进入控制台</>}</button>
        </form>
      </div>
    </section>
  </main>
}

function Dashboard({ session, onExpired, theme, toggleTheme }: { session: Session; onExpired: () => void; theme: Theme; toggleTheme: () => void }) {
  const [view, setView] = useState<View>('overview'); const [loggingOut, setLoggingOut] = useState(false)
  async function logout() { setLoggingOut(true); try { await request('logout', { method: 'POST' }, session.csrfToken) } finally { onExpired() } }
  return <div className="min-h-[100dvh]">
    <header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-6"><Brand compact/>
        <div className="flex items-center gap-3"><span className="hidden items-center gap-2 text-xs text-muted sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#8fa477]"/>会话已保护</span><ThemeToggle theme={theme} toggle={toggleTheme}/><button onClick={logout} disabled={loggingOut} className="button-secondary" aria-label="退出登录">{loggingOut ? <SpinnerGap className="animate-spin"/> : <SignOut/>}<span className="hidden sm:inline">退出登录</span></button></div>
      </div>
    </header>
    <div className="mx-auto grid max-w-[1400px] md:grid-cols-[210px_minmax(0,1fr)]">
      <nav className="border-b border-line p-3 md:min-h-[calc(100dvh-4rem)] md:border-b-0 md:border-r md:p-4" aria-label="主导航">
        <div className="flex gap-1 md:flex-col">{([['overview', Gauge, '概览'], ['keys', Key, '凭据管理'], ['archives', ArchiveBox, '请求归档']] as const).map(([id, Icon, label]) => <button key={id} onClick={() => setView(id)} className={`flex flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:flex-none ${view === id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-paper/[.05] hover:text-paper'}`}><Icon size={18}/><span>{label}</span></button>)}</div>
      </nav>
      <main className="min-w-0 p-4 sm:p-6 lg:p-9">{view === 'overview' && <Overview/>}{view === 'keys' && <Credentials csrf={session.csrfToken}/>} {view === 'archives' && <Archives/>}</main>
    </div>
  </div>
}

function Overview() {
  const [result, reload] = useResource<Json>('status')
  return <Page title="运行概览" subtitle="实时服务状态与主机资源。" action={<Refresh onClick={reload} loading={result.state === 'loading'}/>}>
    {result.state === 'loading' && <MetricSkeleton/>}
    {result.state === 'error' && <ErrorState message={result.message} retry={reload}/>}
    {result.state === 'ready' && <StatusContent data={result.data}/>}
  </Page>
}
function StatusContent({ data }: { data: Json }) {
  const usage = asObject(pick(data, ['usage'], {}))
  const metrics = [
    { label: '服务', value: pick(data, ['service.status','service','status']), icon: Activity, detail: pick(data, ['service.uptime','uptime'], '运行状态') },
    { label: 'Tailscale', value: pick(data, ['tailscale.status','tailscale.connected','tailscale']), icon: Gauge, detail: pick(data, ['tailscale.ip','tailscale.address','tailscale.hostname'], '网络路径') },
    { label: '请求归档', value: pick(data, ['archives.count','archive_count','archiveCount','archives']), icon: Database, detail: pick(data, ['archives.size','archive_size','archiveSize'], '已记录请求') },
    { label: '可用磁盘', value: formatBytes(pick(data, ['disk.available','disk.free','disk_free','diskFree'])), icon: HardDrives, detail: `${display(pick(data, ['disk.used_percent','disk.usedPercent'], '—'))}${pick(data, ['disk.used_percent','disk.usedPercent'], null) !== null ? '% 已使用' : '主机存储'}` },
  ]
  return <div className="animate-enter"><div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">{metrics.map(({label,value,icon:Icon,detail}) => <section key={label} className="bg-panel p-5"><div className="flex items-center justify-between"><p className="eyebrow">{label}</p><Icon className="text-muted" size={20}/></div><p className="mt-5 truncate text-2xl font-semibold tracking-tight">{display(value)}</p><p className="mt-1 truncate text-xs text-muted">{display(detail)}</p></section>)}</div>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">全局用量</p><h3 className="mt-2 font-semibold">Token 消耗</h3></div><Activity className="text-muted" size={20}/></div><div className="mt-5 grid gap-4 sm:grid-cols-3">{[['输入',pick(usage,['prompt_tokens'])],['输出',pick(usage,['completion_tokens'])],['总计',pick(usage,['total_tokens'])]].map(([label,value])=><div key={text(label)} className="border-t border-line pt-3"><p className="text-xs text-muted">{display(label)} Token</p><p className="mt-1 text-xl font-semibold">{display(value)}</p></div>)}</div></section>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#8fa477]"/><h3 className="font-semibold">系统响应</h3></div><p className="mt-2 text-sm text-muted">状态接口响应正常，更新时间：{new Date().toLocaleTimeString()}。</p></section></div>
}

function Credentials({ csrf }: { csrf: string }) {
  const [keys, reload] = useResource<unknown>('client-keys'); const [upstream, reloadUpstream] = useResource<unknown>('upstream-key')
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [revealed, setRevealed] = useState(''); const [copied, setCopied] = useState(false)
  const [upstreamValue, setUpstreamValue] = useState(''); const [showUpstream, setShowUpstream] = useState(false)
  const rows = keys.state === 'ready' ? arrayFrom(keys.data, 'keys', 'items', 'data') : []
  async function generate() { setBusy('generate'); setError(''); try { const body = await request('client-keys', { method:'POST', body: '{}' }, csrf); const obj = asObject(body); setRevealed(text(pick(obj, ['key','clientKey','client_key','token'], ''))); reload() } catch(e) { setError(errorMessage(e)) } finally { setBusy('') } }
  async function remove(id: string) { if (!window.confirm('确定撤销此客户端密钥？使用该密钥的客户端将无法继续访问。')) return; setBusy(id); setError(''); try { await request(`client-keys?id=${encodeURIComponent(id)}`, { method:'DELETE' }, csrf); reload() } catch(e) { setError(errorMessage(e)) } finally { setBusy('') } }
  async function saveUpstream(e: FormEvent) { e.preventDefault(); if (!upstreamValue) return; setBusy('upstream'); setError(''); try { await request('upstream-key', { method:'PUT', body: JSON.stringify({ key: upstreamValue }) }, csrf); setUpstreamValue(''); reloadUpstream() } catch(err) { setError(errorMessage(err)) } finally { setBusy('') } }
  async function copyKey() { try { await navigator.clipboard.writeText(revealed); setCopied(true); window.setTimeout(() => setCopied(false), 1800) } catch { setError('无法访问剪贴板，请手动选择并复制密钥。') } }
  return <Page title="凭据管理" subtitle="管理客户端访问权限和上游服务密钥。" action={<button onClick={generate} disabled={!!busy} className="button-primary"><Plus/>生成密钥</button>}>
    {error && <InlineAlert message={error}/>} {revealed && <section aria-live="polite" className="mb-6 rounded-lg border border-accent/40 bg-accent/10 p-5 animate-enter"><div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-accent">请立即复制此密钥</p><p className="mt-1 text-sm text-muted">关闭此提示后，密钥将不再显示。</p></div><button onClick={() => setRevealed('')} className="rounded p-1 text-muted hover:text-paper" aria-label="关闭"><X/></button></div><div className="mt-4 flex flex-col gap-2 sm:flex-row"><code className="min-w-0 flex-1 overflow-x-auto rounded bg-ink p-3 font-mono text-sm">{revealed}</code><button onClick={copyKey} className="button-secondary">{copied ? <Check/> : <Clipboard/>}{copied ? '已复制' : '复制'}</button></div></section>}
    <section className="surface overflow-hidden rounded-lg"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h3 className="font-semibold">客户端密钥</h3><p className="mt-1 text-xs text-muted">已获准调用代理的密钥</p></div><span className="rounded bg-paper/[.06] px-2 py-1 text-xs text-muted">{rows.length} 个</span></div>
      {keys.state === 'loading' ? <ListSkeleton/> : keys.state === 'error' ? <ErrorState message={keys.message} retry={reload}/> : rows.length === 0 ? <EmptyState icon={<Key/>} title="暂无客户端密钥" body="生成密钥以授权首个客户端。"/> : <div className="divide-y divide-line">{rows.map((raw, index) => { const row = asObject(raw); const id = text(pick(row,['id','key_id','keyId'], String(index))); return <div key={id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><p className="truncate font-mono text-sm">{display(pick(row,['masked','key','prefix','name'], `密钥 ${index + 1}`))}</p><p className="mt-1 text-xs text-muted">创建于 {formatDate(pick(row,['created_at','createdAt','created']))}</p></div><button onClick={() => remove(id)} disabled={busy === id} className="button-secondary text-accent">{busy === id ? <SpinnerGap className="animate-spin"/> : <X/>}撤销</button></div>})}</div>}
    </section>
    <section className="surface mt-6 rounded-lg p-5"><div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]"><div><p className="eyebrow">服务商凭据</p><h3 className="mt-2 font-semibold">上游 API 密钥</h3><p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted">更换上游请求使用的凭据。当前值始终脱敏，且不会存储在浏览器中。</p>{upstream.state === 'ready' && <p className="mt-4 font-mono text-sm">当前：{display(pick(asObject(upstream.data), ['masked','key','value'], '已配置'))}</p>}{upstream.state === 'error' && <p className="mt-3 text-sm text-accent">{upstream.message}</p>}</div>
      <form onSubmit={saveUpstream} className="space-y-2"><label htmlFor="upstream" className="text-sm font-medium">新的上游密钥</label><div className="relative"><input id="upstream" className="field pr-11" type={showUpstream?'text':'password'} autoComplete="off" value={upstreamValue} onChange={e=>setUpstreamValue(e.target.value)} placeholder="输入替换密钥"/><button type="button" onClick={()=>setShowUpstream(v=>!v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted hover:text-paper" aria-label="切换密钥可见性">{showUpstream?<EyeSlash/>:<Eye/>}</button></div><button className="button-primary mt-2 w-full" disabled={!upstreamValue||busy==='upstream'}>{busy==='upstream'?<SpinnerGap className="animate-spin"/>:<Key/>}更新上游密钥</button></form></div></section>
  </Page>
}

function Archives() {
  const [cursor, setCursor] = useState(''); const [selected, setSelected] = useState<Json|null>(null); const [refreshKey, setRefreshKey] = useState(0)
  const [result, setResult] = useState<Load<unknown>>({state:'loading'})
  const load = useCallback(async () => { setResult({state:'loading'}); try { setResult({state:'ready',data:await request(`archives?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)}) } catch(e){ setResult({state:'error',message:errorMessage(e)}) } },[cursor,refreshKey])
  useEffect(()=>{void load()},[load]); const obj=result.state==='ready'?asObject(result.data):{}; const rows=result.state==='ready'?arrayFrom(result.data,'archives','items','data'):[]; const next=text(pick(obj,['next_cursor','nextCursor','cursor'],''))
  if(selected) return <ArchiveDetail archive={selected} onBack={()=>setSelected(null)}/>
  return <Page title="请求归档" subtitle="查看已记录的请求与响应。" action={<Refresh onClick={()=>setRefreshKey(k=>k+1)} loading={result.state==='loading'}/>}>{result.state==='loading'?<ListSkeleton rows={7}/>:result.state==='error'?<ErrorState message={result.message} retry={load}/>:rows.length===0?<EmptyState icon={<ArchiveBox/>} title="暂无归档请求" body="启用归档记录后，捕获的流量将显示在这里。"/>:<><div className="surface overflow-hidden rounded-lg"><div className="hidden grid-cols-[1fr_110px_150px_190px] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted md:grid"><span>请求</span><span>状态</span><span>耗时</span><span>时间</span></div><div className="divide-y divide-line">{rows.map((raw,index)=>{const row=asObject(raw);return <button key={text(pick(row,['id','archive_id'],index))} onClick={()=>setSelected(row)} className="grid w-full gap-2 px-5 py-4 text-left outline-none transition hover:bg-paper/[.04] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:grid-cols-[1fr_110px_150px_190px] md:items-center md:gap-4"><div className="min-w-0"><p className="truncate text-sm font-medium">{display(pick(row,['method'],'POST'))} <span className="text-muted">{display(pick(row,['request_uri','path','url','endpoint'],pick(row,['id'],'请求')))}</span></p><p className="mt-1 truncate font-mono text-xs text-muted">{display(pick(row,['id','archive_id']))}</p></div><span className="text-sm">{display(pick(row,['response_status','status','status_code','statusCode']))}</span><span className="text-sm text-muted">{display(pick(row,['duration','duration_ms','durationMs']))}{pick(row,['duration_ms','durationMs'],null)!==null?' ms':''}</span><span className="text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp','time']))}</span></button>})}</div></div>{next&&<div className="mt-4 flex justify-end"><button className="button-secondary" onClick={()=>setCursor(next)}>加载下一页</button></div>}</>}
  </Page>
}

function ArchiveDetail({ archive, onBack }: { archive: Json; onBack:()=>void }) {
  const id=text(pick(archive,['id','archive_id'])); const [detail]=useResource<Json>(`archives/${encodeURIComponent(id)}`); const [req]=useResource<unknown>(`archives/${encodeURIComponent(id)}/request`); const [res]=useResource<unknown>(`archives/${encodeURIComponent(id)}/response`)
  const data=detail.state==='ready'?{...archive,...detail.data}:archive
  return <Page title="归档详情" subtitle={id} action={<button className="button-secondary" onClick={onBack}><List/>返回归档</button>}>
    <div className="mb-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">{[['请求方法',pick(data,['method'])],['状态',pick(data,['response_status','status','status_code','statusCode'])],['耗时',pick(data,['duration','duration_ms','durationMs'])],['记录时间',formatDate(pick(data,['started_at','created_at','createdAt','timestamp','time']))]].map(([label,value])=><div key={text(label)} className="bg-panel p-4"><p className="eyebrow">{display(label)}</p><p className="mt-2 truncate text-sm font-semibold">{display(value)}</p></div>)}</div>
    {detail.state==='error'&&<InlineAlert message={detail.message}/>}<ConversationView request={req} response={res}/>
  </Page>
}

type ChatMessage = { role: string; content: string; meta?: string }
function parseBody(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return ''
  try { return JSON.parse(trimmed) } catch { return value }
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => {
    if (typeof part === 'string') return part
    const item = asObject(part); const kind = text(item.type)
    if (kind === 'text' || kind === 'input_text' || kind === 'output_text') return text(item.text)
    if (kind === 'thinking') return text(item.thinking)
    if (kind === 'image' || kind === 'image_url') return '[图片]'
    if (kind === 'tool_use') return `调用工具 ${text(item.name)}\n${pretty(item.input)}`
    if (kind === 'tool_result') return `工具结果\n${contentText(item.content)}`
    return text(item.text || item.content) || pretty(item)
  }).filter(Boolean).join('\n\n')
  if (value && typeof value === 'object') return text(asObject(value).text) || pretty(value)
  return text(value)
}
function requestMessages(value: unknown): ChatMessage[] {
  const body = asObject(parseBody(value)); const result: ChatMessage[] = []
  const system = body.system
  if (system) result.push({ role: 'system', content: contentText(system) })
  for (const raw of arrayFrom(body.messages)) {
    const message = asObject(raw); let content = contentText(message.content)
    const calls = arrayFrom(message.tool_calls)
    if (calls.length) content += `${content ? '\n\n' : ''}${calls.map(call => { const c=asObject(call); const fn=asObject(c.function); return `调用工具 ${text(fn.name || c.name)}\n${text(fn.arguments) || pretty(c.input)}` }).join('\n\n')}`
    result.push({ role: text(message.role) || 'user', content: content || '（空内容）', meta: text(message.name) })
  }
  if (!result.length && body.prompt) result.push({ role: 'user', content: contentText(body.prompt) })
  return result
}
function responseMessages(value: unknown): ChatMessage[] {
  const parsed = parseBody(value)
  if (typeof parsed === 'string') {
    const chunks = parsed.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(line => line && line !== '[DONE]')
    if (chunks.length) {
      let answer = '', reasoning = ''
      for (const chunk of chunks) { try { const data=asObject(JSON.parse(chunk)); const choice=asObject(arrayFrom(data.choices)[0]); const delta=asObject(choice.delta); answer += text(delta.content); reasoning += text(delta.reasoning_content) } catch { /* ignore malformed SSE chunk */ } }
      return [...(reasoning ? [{role:'thinking',content:reasoning}] : []), ...(answer ? [{role:'assistant',content:answer}] : [])]
    }
    return parsed.trim() ? [{ role: 'assistant', content: parsed }] : []
  }
  const body = asObject(parsed); const result: ChatMessage[] = []
  for (const raw of arrayFrom(body.choices)) {
    const choice=asObject(raw); const message=asObject(choice.message); const reasoning=text(message.reasoning_content)
    if (reasoning) result.push({role:'thinking',content:reasoning})
    const content=contentText(message.content ?? choice.text)
    if (content) result.push({role:text(message.role)||'assistant',content})
  }
  if (!result.length && body.content) result.push({role:text(body.role)||'assistant',content:contentText(body.content)})
  if (!result.length && body.output) result.push({role:'assistant',content:contentText(body.output)})
  return result
}
function roleLabel(role:string) { return ({system:'系统',user:'用户',assistant:'助手',tool:'工具',thinking:'思考过程'} as Record<string,string>)[role] || role }
function ConversationView({request,response}:{request:Load<unknown>;response:Load<unknown>}) {
  if(request.state==='loading'||response.state==='loading') return <ListSkeleton rows={5}/>
  const errors=[request.state==='error'?request.message:'',response.state==='error'?response.message:''].filter(Boolean)
  const messages=[...(request.state==='ready'?requestMessages(request.data):[]),...(response.state==='ready'?responseMessages(response.data):[])]
  return <div className="space-y-6">
    {errors.map(error=><InlineAlert key={error} message={error}/>)}
    <section className="surface overflow-hidden rounded-xl"><div className="border-b border-line bg-paper/[.025] px-5 py-4"><h3 className="font-semibold">对话内容</h3><p className="mt-1 text-xs text-muted">已按消息顺序还原请求与响应</p></div>
      {messages.length===0?<EmptyState icon={<Code/>} title="无法识别对话结构" body="可在下方展开原始数据查看完整内容。"/>:<div className="space-y-5 p-4 sm:p-6">{messages.map((message,index)=><article key={index} className={`flex ${message.role==='user'?'justify-end':'justify-start'}`}><div className={`max-w-[92%] sm:max-w-[82%] ${message.role==='user'?'rounded-2xl rounded-br-sm bg-accent text-ink':'rounded-2xl rounded-bl-sm border border-line bg-panel text-paper'} px-4 py-3 shadow-sm`}><div className={`mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide ${message.role==='user'?'text-ink/70':'text-muted'}`}><span>{roleLabel(message.role)}</span>{message.meta&&<span>· {message.meta}</span>}</div><div className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</div></div></article>)}</div>}
    </section>
    <details className="surface group rounded-lg"><summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-semibold"><Code/><span>原始请求与响应</span><span className="ml-auto text-xs font-normal text-muted group-open:hidden">展开</span></summary><div className="grid border-t border-line xl:grid-cols-2"><RawBody title="原始请求" value={request}/><RawBody title="原始响应" value={response}/></div></details>
  </div>
}
function RawBody({title,value}:{title:string;value:Load<unknown>}) { return <section className="min-w-0 border-b border-line last:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0"><div className="border-b border-line px-5 py-3"><h4 className="text-sm font-semibold">{title}</h4></div>{value.state==='loading'?<div className="p-5 text-sm text-muted">正在加载…</div>:value.state==='error'?<div className="p-5 text-sm text-accent">{value.message}</div>:<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words bg-ink p-5 font-mono text-xs leading-6 text-paper">{pretty(value.data)}</pre>}</section> }
function pretty(value:unknown){if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2)}catch{return value||'（空内容）'}}try{return JSON.stringify(value,null,2)}catch{return String(value)}}

function useResource<T=unknown>(path:string):[Load<T>,()=>void]{const [result,setResult]=useState<Load<T>>({state:'loading'});const [tick,setTick]=useState(0);useEffect(()=>{let active=true;setResult({state:'loading'});request(path).then(data=>{if(active)setResult({state:'ready',data:data as T})}).catch(e=>{if(active)setResult({state:'error',message:errorMessage(e)})});return()=>{active=false}},[path,tick]);return[result,()=>setTick(v=>v+1)]}
function Page({title,subtitle,action,children}:{title:string;subtitle:string;action?:ReactNode;children:ReactNode}){return <div className="animate-enter"><div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow">管理后台</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1><p className="mt-2 text-sm text-muted">{subtitle}</p></div>{action&&<div className="shrink-0">{action}</div>}</div>{children}</div>}
function Brand({compact=false}:{compact?:boolean}){return <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded bg-accent text-ink"><Activity weight="bold"/></span><div><p className="text-sm font-semibold leading-none">Zhipu Proxy</p>{!compact&&<p className="mt-1 text-[10px] uppercase tracking-[.18em] text-muted">运维控制台</p>}</div></div>}
function Refresh({onClick,loading}:{onClick:()=>void;loading:boolean}){return <button className="button-secondary" onClick={onClick} disabled={loading}><ArrowClockwise className={loading?'animate-spin':''}/>刷新</button>}
function FullLoader({label}:{label:string}){return <main className="grid min-h-[100dvh] place-items-center p-6"><div className="text-center"><SpinnerGap size={28} className="mx-auto animate-spin text-accent"/><p className="mt-4 text-sm text-muted">{label}</p></div></main>}
function FatalState({message,retry}:{message:string;retry:()=>void}){return <main className="grid min-h-[100dvh] place-items-center p-6"><div className="max-w-md text-center"><WarningCircle className="mx-auto text-accent" size={34}/><h1 className="mt-4 text-xl font-semibold">控制台暂不可用</h1><p className="mt-2 text-sm text-muted">{message}</p><button onClick={retry} className="button-primary mt-6">重试</button></div></main>}
function ErrorState({message,retry}:{message:string;retry:()=>void}){return <div className="surface rounded-lg p-8 text-center"><WarningCircle className="mx-auto text-accent" size={30}/><h3 className="mt-3 font-semibold">无法加载数据</h3><p className="mt-2 text-sm text-muted">{message}</p><button onClick={retry} className="button-secondary mt-5">重试</button></div>}
function EmptyState({icon,title,body}:{icon:ReactNode;title:string;body:string}){return <div className="surface rounded-lg p-10 text-center"><div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-paper/[.06] text-muted">{icon}</div><h3 className="mt-4 font-semibold">{title}</h3><p className="mt-2 text-sm text-muted">{body}</p></div>}
function InlineAlert({message}:{message:string}){return <div role="alert" className="mb-5 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 p-3 text-sm text-accent"><WarningCircle className="mt-0.5 shrink-0"/>{message}</div>}
function MetricSkeleton(){return <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map(i=><div key={i} className="space-y-5 bg-panel p-5"><div className="skeleton h-3 w-20"/><div className="skeleton h-7 w-28"/><div className="skeleton h-3 w-24"/></div>)}</div>}
function ListSkeleton({rows=4}:{rows?:number}){return <div className="surface divide-y divide-line overflow-hidden rounded-lg">{Array.from({length:rows},(_,i)=><div key={i} className="space-y-2 p-5"><div className="skeleton h-4 w-2/5"/><div className="skeleton h-3 w-1/4"/></div>)}</div>}
function UserPortalApp({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) {
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
  if (session.state === 'loading') return <FullLoader label="正在验证客户端会话" />
  if (session.state === 'error') return <FatalState message={session.message} retry={verify} />
  if (!session.data) return <UserLogin theme={theme} toggleTheme={toggleTheme} onLogin={(s) => setSession({ state: 'ready', data: s })} />
  return <UserDashboard theme={theme} toggleTheme={toggleTheme} session={session.data} onLogout={() => setSession({ state: 'ready', data: null })} />
}

function UserLogin({ onLogin, theme, toggleTheme }: { onLogin: (session: Session) => void; theme: Theme; toggleTheme: () => void }) {
  const [key, setKey] = useState(''); const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); if (!key || busy) return; setBusy(true); setError(''); try { const session = extractSession(await request('user-login', { method: 'POST', body: JSON.stringify({ key }) })); if (!session) throw new Error('会话响应无效'); setKey(''); onLogin(session) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) } }
  return <main className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1fr)_minmax(380px,.8fr)]">
    <section className="hidden border-r border-line p-12 lg:flex lg:flex-col lg:justify-between"><Brand/><div className="max-w-xl animate-enter"><p className="eyebrow mb-4">用户中心</p><h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.045em]">你的调用，<br/><span className="text-muted">清晰可查。</span></h1><p className="mt-6 max-w-[52ch] leading-relaxed text-muted">查看 Token 消耗、模型活动和近期代理请求。</p></div><p className="text-xs text-muted">Zhipu Proxy / 用户访问</p></section>
    <section className="relative flex min-h-[100dvh] items-center justify-center p-5 sm:p-10"><div className="absolute right-5 top-5"><ThemeToggle theme={theme} toggle={toggleTheme}/></div><div className="w-full max-w-md animate-enter"><div className="mb-12 lg:hidden"><Brand/></div><p className="eyebrow">用户访问</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">进入用量中心</h2><p className="mt-2 text-sm text-muted">请使用已签发的客户端 API 密钥验证身份。</p><form onSubmit={submit} className="mt-8 space-y-5"><div className="space-y-2"><label htmlFor="client-key" className="text-sm font-medium">客户端 API 密钥</label><div className="relative"><input id="client-key" autoFocus autoComplete="off" className="field pr-11" type={visible?'text':'password'} value={key} onChange={e=>setKey(e.target.value)}/><button type="button" onClick={()=>setVisible(v=>!v)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted hover:text-paper" aria-label={visible?'隐藏密钥':'显示密钥'}>{visible?<EyeSlash/>:<Eye/>}</button></div>{error&&<p role="alert" className="flex items-center gap-2 text-sm text-accent"><WarningCircle/>{error}</p>}</div><button className="button-primary w-full" disabled={!key||busy}>{busy?<SpinnerGap className="animate-spin"/>:<LockKey/>}{busy?'正在验证':'查看我的用量'}</button></form><p className="mt-6 text-xs leading-relaxed text-muted">密钥仅用于验证本次会话，不会存储在浏览器中。</p></div></section>
  </main>
}

function UserDashboard({ session, onLogout, theme, toggleTheme }: { session: Session; onLogout: () => void; theme: Theme; toggleTheme: () => void }) {
  const [view, setView] = useState<'usage'|'requests'>('usage'); const [busy,setBusy]=useState(false)
  async function logout(){setBusy(true);try{await request('user-logout',{method:'POST'},session.csrfToken)}finally{onLogout()}}
  return <div className="min-h-[100dvh]"><header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-6"><Brand compact/><div className="flex items-center gap-3"><span className="hidden text-xs text-muted sm:inline">用户中心</span><ThemeToggle theme={theme} toggle={toggleTheme}/><button className="button-secondary" onClick={logout} disabled={busy}>{busy?<SpinnerGap className="animate-spin"/>:<SignOut/>}<span className="hidden sm:inline">退出登录</span></button></div></div></header><div className="mx-auto grid max-w-[1400px] md:grid-cols-[210px_minmax(0,1fr)]"><nav className="border-b border-line p-3 md:min-h-[calc(100dvh-4rem)] md:border-b-0 md:border-r md:p-4"><div className="flex gap-1 md:flex-col"><PortalNav active={view==='usage'} onClick={()=>setView('usage')} icon={<Gauge/>} label="我的用量"/><PortalNav active={view==='requests'} onClick={()=>setView('requests')} icon={<ArchiveBox/>} label="我的请求"/></div></nav><main className="min-w-0 p-4 sm:p-6 lg:p-9">{view==='usage'?<UserUsage onRequests={()=>setView('requests')}/>:<UserArchives/>}</main></div></div>
}
function PortalNav({active,onClick,icon,label}:{active:boolean;onClick:()=>void;icon:ReactNode;label:string}){return <button onClick={onClick} className={`flex flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:flex-none ${active?'bg-accent/15 text-accent':'text-muted hover:bg-paper/[.05] hover:text-paper'}`}>{icon}{label}</button>}

function UserUsage({onRequests}:{onRequests:()=>void}) {
  const [result,reload]=useResource<Json>('user-usage')
  return <Page title="我的用量" subtitle="此客户端密钥的 Token 消耗和模型活动。" action={<Refresh onClick={reload} loading={result.state==='loading'}/>}>{result.state==='loading'?<MetricSkeleton/>:result.state==='error'?<ErrorState message={result.message} retry={reload}/>:<UserUsageContent data={result.data} onRequests={onRequests}/>}</Page>
}
function UserUsageContent({data,onRequests}:{data:Json;onRequests:()=>void}){
  const metrics=[['请求数',pick(data,['request_count','requestCount','requests'])],['输入 Token',pick(data,['prompt_tokens','promptTokens','usage.prompt_tokens','tokens.prompt'])],['缓存 Token',pick(data,['usage.cached_tokens','cached_tokens','tokens.cached'],0)],['输出 Token',pick(data,['completion_tokens','completionTokens','usage.completion_tokens','tokens.completion'])],['总计 Token',pick(data,['total_tokens','totalTokens','usage.total_tokens','tokens.total'])]]
  const distRaw=pick(data,['model_distribution','modelDistribution','models'],{}); const distribution=Array.isArray(distRaw)?distRaw.map(asObject):Object.entries(asObject(distRaw)).map(([model,count])=>({model,count})); const max=Math.max(1,...distribution.map(r=>Number(pick(r,['count','requests','value'],0))))
  const recent=arrayFrom(pick(data,['recent_requests','recentRequests','recent'],[]),'items')
  return <div className="animate-enter"><div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-5">{metrics.map(([label,value])=><section key={text(label)} className="bg-panel p-5"><p className="eyebrow">{display(label)}</p><p className="mt-5 text-2xl font-semibold tracking-tight">{display(value)}</p></section>)}</div><div className="mt-6 grid gap-6 lg:grid-cols-[.8fr_1.2fr]"><section className="surface rounded-lg p-5"><h3 className="font-semibold">模型分布</h3><p className="mt-1 text-xs text-muted">按模型统计请求</p>{distribution.length===0?<p className="mt-8 text-sm text-muted">暂无模型调用。</p>:<div className="mt-6 space-y-4">{distribution.map((row,i)=>{const count=Number(pick(row,['count','requests','value'],0));return <div key={i}><div className="mb-1.5 flex justify-between gap-4 text-sm"><span className="truncate">{display(pick(row,['model','name'],`模型 ${i+1}`))}</span><span className="text-muted">{count.toLocaleString()}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-ink"><div className="h-full rounded-full bg-accent" style={{width:`${Math.max(3,count/max*100)}%`}}/></div></div>})}</div>}</section><section className="surface overflow-hidden rounded-lg"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h3 className="font-semibold">近期请求</h3><p className="mt-1 text-xs text-muted">此密钥的最新活动</p></div><button className="text-xs font-semibold text-accent hover:text-paper" onClick={onRequests}>查看全部</button></div>{recent.length===0?<div className="p-8 text-center text-sm text-muted">暂无请求记录。</div>:<div className="divide-y divide-line">{recent.slice(0,6).map((raw,i)=>{const row=asObject(raw);return <div key={i} className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3"><div className="min-w-0"><p className="truncate text-sm">{display(pick(row,['model','path','endpoint'],'请求'))}</p><p className="mt-1 text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp']))}</p></div><UsageBreakdown row={row} compact/></div>})}</div>}</section></div></div>
}

function UsageBreakdown({row,compact=false}:{row:Json;compact?:boolean}) {
  const input=pick(row,['usage.prompt_tokens','prompt_tokens','promptTokens'],0)
  const cached=pick(row,['usage.cached_tokens','cached_tokens','cache_read_input_tokens'],0)
  const output=pick(row,['usage.completion_tokens','completion_tokens','completionTokens'],0)
  const total=pick(row,['usage.total_tokens','total_tokens','totalTokens','tokens'],0)
  return <div className={`grid grid-cols-4 gap-3 ${compact?'text-[11px]':'text-xs'}`}>{[['输入',input],['缓存',cached],['输出',output],['总计',total]].map(([label,value])=><div key={text(label)} className="min-w-0"><span className="block text-muted">{text(label)}</span><strong className="mt-0.5 block truncate font-semibold text-paper">{display(value)}</strong></div>)}</div>
}

function UserArchives(){
  const [cursor,setCursor]=useState('');const path=`user-archives?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;const [result,reload]=useResource<unknown>(path);const obj=result.state==='ready'?asObject(result.data):{};const rows=result.state==='ready'?arrayFrom(result.data,'archives','items','data'):[];const next=text(pick(obj,['next_cursor','nextCursor','cursor'],''));
  return <Page title="我的请求" subtitle="仅展示此客户端密钥的用量与状态，不展示具体请求内容。" action={<Refresh onClick={reload} loading={result.state==='loading'}/>}>{result.state==='loading'?<ListSkeleton rows={7}/>:result.state==='error'?<ErrorState message={result.message} retry={reload}/>:rows.length===0?<EmptyState icon={<ArchiveBox/>} title="暂无请求记录" body="你的代理请求统计将显示在这里。"/>:<><div className="surface overflow-hidden rounded-lg"><div className="divide-y divide-line">{rows.map((raw,i)=>{const row=asObject(raw);return <div key={text(pick(row,['id'],i))} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(160px,1fr)_80px_minmax(260px,1.2fr)_180px] lg:items-center"><div className="min-w-0"><p className="truncate text-sm font-medium">{display(pick(row,['model'],'模型调用'))}</p><p className="mt-1 text-xs text-muted">请求内容仅管理员可见</p></div><span className="text-sm"><span className="mr-2 text-xs text-muted lg:hidden">状态</span>{display(pick(row,['response_status','status','status_code','statusCode']))}</span><UsageBreakdown row={row}/><span className="text-xs text-muted">{formatDate(pick(row,['started_at','created_at','createdAt','timestamp']))}</span></div>})}</div></div>{next&&<div className="mt-4 flex justify-end"><button className="button-secondary" onClick={()=>setCursor(next)}>加载下一页</button></div>}</>}</Page>
}

function errorMessage(error:unknown){return error instanceof Error?error.message:'发生未知错误。'}
