(window as any).__ModuleLoader__.load({
  id: 'dsh-antigravity',
  factory: (require: (id: string) => any) => {
    var module = { exports: {} as any }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /**
     * Browser half of dsh-antigravity: the provider card's account manager in
     * Settings → Models.
     *
     * It renders inside the `settings.models.provider-card` keyed slot for the
     * `llm-antigravity` settings namespace and talks to the host over the
     * loopback routes the host half registers: every installed Google account
     * with its own health, plus adding one, choosing the default, and signing
     * one out. No secrets cross the wire — the host owns the OAuth exchange and
     * keeps the grants in its account registry.
     *
     * Every element is built with `React.createElement`, whose trailing
     * arguments are children. The automatic `jsx`/`jsxs` runtime instead reads
     * children from `props.children` and treats its third argument as the key,
     * so calling it in `createElement` shape silently renders empty elements.
     */
    /** One installed account as the host publishes it (never a secret). */
    interface AccountRow {
      id: string
      label?: string | null
      email?: string | null
      projectId?: string | null
      expires?: number | null
      timeLeftSeconds?: number | null
      expired?: boolean
      cooling?: boolean
      cooldownSeconds?: number | null
      active?: boolean
      lastError?: string | null
    }

    /** Payload of the host's `/dsh-antigravity/auth/status` route. */
    interface Status {
      authenticated?: boolean
      pending?: boolean
      expired?: boolean
      email?: string | null
      projectId?: string | null
      expires?: number | null
      timeLeftSeconds?: number | null
      loginUrl?: string | null
      error?: string | null
      /** Every installed account, in registry order. */
      accounts?: AccountRow[]
      activeAccountId?: string | null
      strategy?: string
    }

    /** Locale strings this card renders. */
    interface Copy {
      signedIn: string
      signedOut: string
      expired: string
      signIn: string
      signOut: string
      cancel: string
      waiting: string
      reopen: string
      project: string
      expires: string
      minutes: string
      retry: string
      failed: string
      accountsUnit: string
      addAccount: string
      setActive: string
      active: string
      cooling: string
      recoversIn: string
      account: string
      strategyRoundRobin: string
      strategyActiveFirst: string
      strategyPrefix: string
    }

    const ROUTE = '/dsh-antigravity/auth'
    const PROVIDER = 'google-antigravity'
    const POLL_MS = 1500

    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const copy: Copy = zh
      ? {
          signedIn: '已登录',
          signedOut: '未登录',
          expired: '登录已过期，请重新登录',
          signIn: '登录 Google 账号',
          signOut: '退出登录',
          cancel: '取消',
          waiting: '等待浏览器完成授权…',
          reopen: '重新打开授权页',
          project: '项目',
          expires: '令牌有效',
          minutes: '分钟',
          retry: '重试',
          failed: '操作失败',
          accountsUnit: '个账号',
          addAccount: '添加账号',
          setActive: '设为默认',
          active: '默认',
          cooling: '配额冷却中',
          recoversIn: '约',
          account: 'Google 账号',
          strategyRoundRobin: '轮询使用',
          strategyActiveFirst: '优先默认账号',
          strategyPrefix: '策略'
        }
      : {
          signedIn: 'Signed in',
          signedOut: 'Not signed in',
          expired: 'Session expired — sign in again',
          signIn: 'Sign in with Google',
          signOut: 'Sign out',
          cancel: 'Cancel',
          waiting: 'Waiting for the browser to finish…',
          reopen: 'Reopen authorization page',
          project: 'Project',
          expires: 'Token valid for',
          minutes: 'min',
          retry: 'Retry',
          failed: 'Request failed',
          accountsUnit: 'accounts',
          addAccount: 'Add account',
          setActive: 'Make default',
          active: 'Default',
          cooling: 'Quota cooling',
          recoversIn: 'back in ~',
          account: 'Google account',
          strategyRoundRobin: 'Round-robin',
          strategyActiveFirst: 'Active first',
          strategyPrefix: 'Strategy'
        }

    async function call(path: string, init?: RequestInit): Promise<any> {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (init && init.body !== undefined) headers['content-type'] = 'application/json'
      if (init && init.headers) Object.assign(headers, init.headers as Record<string, string>)
      const response = await fetch(`${ROUTE}${path}`, Object.assign({}, init, { headers }))
      let payload: any = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    /** Only tokens the Theme service actually publishes; an unknown name is dropped silently. */
    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      label: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', opacity: '0.75' },
      error: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
      link: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-brand-primary)' },
      spacer: { flex: '1 1 auto' },
      // One account per block, separated from its neighbour by a hairline so a
      // list of five reads as five rows rather than one wrapped paragraph.
      account: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)'
      },
      badge: {
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '999px',
        color: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)'
      },
      detail: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', opacity: '0.75' }
    }

    function AntigravityCard(props: any) {
      const provider = props && props.provider
      /**
       * Whether this instance mounted while the provider still had no installed
       * row, i.e. it is the 「添加提供方」 draft's copy of the card.
       *
       * The owner dispatches this keyed cell with the same directory row from
       * both sites, so no prop distinguishes "draft" from "saved row" — mount
       * time is the one fact that does. The saved row only exists once the
       * account marker is written, so it always mounts `configured === true`,
       * while the draft mounts the cell from the dormant entry
       * (`configured === false`).
       */
      const draftCopy = React.useRef(props == null || props.configured !== true).current
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [authUrl, setAuthUrl] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const next: Status = await call('/status')
          setStatus(next)
          setAuthUrl(next.loginUrl || null)
          setError(null)
        } catch (cause) {
          setError(cause.message)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const next: Status = await call('/status')
            if (!alive) return
            setStatus(next)
            setAuthUrl(next.loginUrl || null)
            setError(null)
          } catch (cause) {
            if (alive) setError(cause.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(() => {
        if (!status || status.pending !== true) return undefined
        const timer = setInterval(() => {
          refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [status && status.pending, refresh])

      const run = React.useCallback(
        async (fn: () => Promise<any>) => {
          setBusy(true)
          setError(null)
          try {
            await fn()
            await refresh()
          } catch (cause) {
            setError(cause.message)
          } finally {
            setBusy(false)
          }
        },
        [refresh]
      )

      const startLogin = () =>
        run(async () => {
          const started = await call('/login', { method: 'POST' })
          setAuthUrl(started.url)
          setStatus(current => Object.assign({}, current || {}, { pending: true, loginUrl: started.url }))
          if (started.url) {
            try {
              window.open(started.url, '_blank', 'noopener,noreferrer')
            } catch {
              /* popup blocked — the link below is still clickable */
            }
          }
        })

      if (provider && provider.provider && provider.provider !== PROVIDER) return null
      // Once the marker lands the provider owns a saved row, and the draft's
      // copy has nothing left to say. The native page leaves its own draft open
      // after a sign-in (the card writes settings itself, so no editor close
      // ever runs to clear it), while the entry has already left the draft's
      // provider select — so a card still rendered here reads as if it belonged
      // to whichever provider that select falls back to. The saved row carries
      // the same status and actions, so dropping this copy loses nothing.
      if (draftCopy && props != null && props.configured === true) return null

      const accounts: AccountRow[] = status != null && Array.isArray(status.accounts) ? status.accounts : []
      const authenticated = status != null && status.authenticated === true
      const pending = status != null && status.pending === true
      const expired = status != null && status.expired === true
      // The host records why an attempt ended without a grant (cancelled,
      // timed out, exchange failure). Without rendering it the card silently
      // drops back to "not signed in" and the human is left guessing, so
      // surface the reason unless the status line already says it.
      const notice =
        status != null && !authenticated && !pending && !expired && status.error ? String(status.error) : null

      // The heading counts accounts rather than naming one: with several
      // installed, no single identity describes the provider any more, and each
      // row below carries its own.
      const heading = pending
        ? copy.waiting
        : accounts.length > 0
          ? accounts.length === 1
            ? copy.signedIn
            : `${copy.signedIn} · ${accounts.length} ${copy.accountsUnit}`
          : expired
            ? copy.expired
            : copy.signedOut

      const head = h(
        'div',
        { style: styles.row },
        h('span', {
          key: 'dot',
          style: Object.assign({}, styles.dot, {
            background: authenticated
              ? 'var(--dsw-alias-state-success-primary)'
              : pending
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-error-primary)'
          })
        }),
        h('span', { key: 'label', style: styles.label }, heading),
        accounts.length > 1
          ? h(
              'span',
              { key: 'strategy', style: styles.hint },
              `${copy.strategyPrefix}：${status!.strategy === 'active-first' ? copy.strategyActiveFirst : copy.strategyRoundRobin}`
            )
          : null
      )

      /** Ask the host to make one account the default. */
      const chooseAccount = (id: string) =>
        run(() => call('/accounts/active', { method: 'POST', body: JSON.stringify({ id }) }))

      /** Sign one account out; the other accounts stay installed. */
      const removeAccount = (id: string) =>
        run(() => call('/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) }))

      /**
       * One installed account: identity, health, and what can be done to it.
       *
       * The dot is per account on purpose — a pool whose second account is
       * quota-parked is exactly the state this card exists to show, and a single
       * provider-level dot cannot express it.
       */
      const accountRow = (account: AccountRow, index: number) => {
        const cooling = account.cooling === true
        const accountExpired = account.expired === true
        const cooldownMinutes =
          typeof account.cooldownSeconds === 'number' ? Math.max(1, Math.round(account.cooldownSeconds / 60)) : null
        const leftMinutes =
          typeof account.timeLeftSeconds === 'number' ? Math.max(0, Math.round(account.timeLeftSeconds / 60)) : null
        const state = cooling
          ? `${copy.cooling}${cooldownMinutes === null ? '' : `，${copy.recoversIn}${cooldownMinutes} ${copy.minutes}`}`
          : accountExpired
            ? copy.expired
            : leftMinutes === null
              ? null
              : `${copy.expires} ~${leftMinutes} ${copy.minutes}`
        const detail = [account.projectId ? `${copy.project}: ${account.projectId}` : null, state]
          .filter(Boolean)
          .join(' · ')
        return h(
          'div',
          { key: account.id || String(index), style: styles.account },
          h(
            'div',
            { style: styles.row },
            h('span', {
              key: 'dot',
              style: Object.assign({}, styles.dot, {
                background: cooling
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : accountExpired
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-state-success-primary)'
              })
            }),
            h('span', { key: 'who', style: styles.label }, account.email || account.label || copy.account),
            account.active === true ? h('span', { key: 'badge', style: styles.badge }, copy.active) : null,
            h('span', { key: 'spacer', style: styles.spacer }),
            account.active === true
              ? null
              : h(
                  Button,
                  {
                    key: 'use',
                    variant: 'outline',
                    size: 'sm',
                    disabled: busy,
                    onClick: () => chooseAccount(account.id)
                  },
                  copy.setActive
                ),
            h(
              Button,
              {
                key: 'out',
                variant: 'outline',
                size: 'sm',
                disabled: busy,
                onClick: () => removeAccount(account.id)
              },
              copy.signOut
            )
          ),
          detail === '' ? null : h('div', { style: styles.detail }, detail)
        )
      }

      const actions = pending
        ? h(
            'div',
            { style: styles.row },
            h('span', { key: 'wait', style: styles.hint }, copy.waiting),
            authUrl
              ? h(
                  'a',
                  {
                    key: 'link',
                    href: authUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    style: styles.link
                  },
                  copy.reopen
                )
              : null,
            h(
              Button,
              {
                key: 'cancel',
                variant: 'outline',
                size: 'sm',
                disabled: busy,
                onClick: () => run(() => call('/cancel', { method: 'POST' }))
              },
              copy.cancel
            )
          )
        : h(
            'div',
            { style: styles.row },
            h(
              Button,
              {
                key: 'in',
                // The first account is the primary action; every later one is
                // an addition to a provider that is already installed.
                variant: accounts.length === 0 ? 'primary' : 'outline',
                size: 'sm',
                disabled: busy,
                onClick: startLogin
              },
              accounts.length === 0 ? copy.signIn : copy.addAccount
            )
          )

      return h(
        'div',
        { style: styles.wrap, 'data-dsh-antigravity': 'card' },
        head,
        accounts.length > 0 ? h('div', null, accounts.map(accountRow)) : null,
        actions,
        notice ? h('p', { key: 'notice', style: styles.hint }, notice) : null,
        error ? h('p', { key: 'error', style: styles.error }, `${copy.failed}: ${error}`) : null
      )
    }

    // -----------------------------------------------------------------------
    // Usage panel — rendered as its own Settings page.
    //
    // The panel is a reader of the host's `/dsh-antigravity/usage` routes; all
    // arithmetic happens on the host, so the browser only formats. Charts are
    // hand-drawn SVG: the browser half is delivered untranspiled and may only
    // require what DSH publishes, so pulling in a charting library is not an
    // option worth its weight for two polylines.
    // -----------------------------------------------------------------------
    const USAGE_ROUTE = '/dsh-antigravity/usage'
    const USAGE_REFRESH_MS = 30_000

    const usageCopy = zh
      ? {
          title: 'Antigravity 用量',
          requests: '请求数',
          totalTokens: '总词元',
          cacheRate: '缓存命中率',
          cost: '等价成本',
          input: '输入词元',
          output: '输出词元',
          cacheRead: '缓存读取词元',
          avgTtft: '平均 TTFT',
          avgDuration: '平均时长',
          throughput: '输出速率',
          errors: '错误率',
          trend: '请求趋势',
          byModel: '按模型',
          byProject: '按项目',
          byAccount: '按账号',
          bySession: '按会话',
          recent: '最近请求',
          refresh: '刷新',
          refreshing: '刷新中…',
          loading: '加载中…',
          noData: '暂无数据',
          model: '模型',
          project: '项目',
          account: '账号',
          session: '会话',
          calls: '请求',
          tokens: '词元',
          ttft: 'TTFT',
          duration: '时长',
          status: '状态',
          time: '时间',
          empty: '还没有记录到 Google Antigravity 调用。用这个提供商跑一次对话后，这里就会出现数据。',
          costHint: '按内置单价估算的 API 等价价值，不是实际账单（Antigravity 是订阅制）。',
          recorded: '已记录',
          span: '跨度',
          disabled: '用量记录已在设置中关闭',
          ok: '成功',
          failed: '失败',
          aborted: '已中止',
          note: '日桶按本地时区对齐。统计出的历史记录没有延迟与停止原因（会话日志不保存），一律计为成功',
          backfill: '重新统计',
          backfilling: '统计中…',
          backfillDone: '已统计',
          backfillEmpty: '没有可统计的历史记录',
          autoScan: '正在统计历史用量…',
          lifetime: '累计（全部时间）',
          rangeEmptyPrefix: '该时间范围内没有记录；累计有 ',
          rangeEmptySuffix: ' 次调用，可切到「全部」查看'
        }
      : {
          title: 'Antigravity usage',
          requests: 'Requests',
          totalTokens: 'Total tokens',
          cacheRate: 'Cache rate',
          cost: 'API-equivalent cost',
          input: 'Input tokens',
          output: 'Output tokens',
          cacheRead: 'Cache reads',
          avgTtft: 'Avg TTFT',
          avgDuration: 'Avg duration',
          throughput: 'Output rate',
          errors: 'Error rate',
          trend: 'Request trend',
          byModel: 'By model',
          byProject: 'By project',
          byAccount: 'By account',
          bySession: 'By session',
          recent: 'Recent requests',
          refresh: 'Refresh',
          refreshing: 'Refreshing…',
          loading: 'Loading…',
          noData: 'No data',
          model: 'Model',
          project: 'Project',
          account: 'Account',
          session: 'Session',
          calls: 'Calls',
          tokens: 'Tokens',
          ttft: 'TTFT',
          duration: 'Duration',
          status: 'Status',
          time: 'Time',
          empty: 'No Google Antigravity calls recorded yet. Run one conversation on this provider and data appears here.',
          costHint: 'Estimated API-equivalent value at the built-in prices, not a bill (Antigravity is subscription-billed).',
          recorded: 'Recorded',
          span: 'Span',
          disabled: 'Usage recording is turned off in settings',
          ok: 'Success',
          failed: 'Failed',
          aborted: 'Aborted',
          note: 'Day buckets are aligned to local time. Scanned history carries no latency or stop reason (session logs do not keep them) and counts as successful',
          backfill: 'Rescan history',
          backfilling: 'Scanning…',
          backfillDone: 'Scanned',
          backfillEmpty: 'No history to scan',
          autoScan: 'Scanning historical usage…',
          lifetime: 'All time',
          rangeEmptyPrefix: 'No calls in this window; ',
          rangeEmptySuffix: ' recorded in total — switch to All to see them'
        }

    const RANGE_LABELS = zh
      ? { '1h': '1 小时', '24h': '24 小时', '7d': '7 天', '30d': '30 天', '90d': '90 天', all: '全部' }
      : { '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d', all: 'All' }

    async function getJson(path: string, init?: any): Promise<any> {
      const response = await fetch(path, Object.assign({ headers: { accept: 'application/json' } }, init))
      let payload: any = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload
    }

    function fmtInt(value: any): string {
      const n = typeof value === 'number' && isFinite(value) ? value : 0
      return n.toLocaleString(zh ? 'zh-CN' : 'en-US')
    }

    function fmtTokens(value: any): string {
      const n = typeof value === 'number' && isFinite(value) ? value : 0
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
      return String(Math.round(n))
    }

    function fmtCost(value: any): string {
      const n = typeof value === 'number' && isFinite(value) ? value : 0
      if (n === 0) return '$0'
      if (n < 0.01) return `$${n.toFixed(4)}`
      if (n < 1) return `$${n.toFixed(3)}`
      return `$${n.toFixed(2)}`
    }

    function fmtMs(value: any): string {
      if (typeof value !== 'number' || !isFinite(value) || value < 0) return '—'
      if (value < 1000) return `${Math.round(value)} ms`
      return `${(value / 1000).toFixed(1)} s`
    }

    function fmtPct(value: any): string {
      const n = typeof value === 'number' && isFinite(value) ? value : 0
      return `${(n * 100).toFixed(1)}%`
    }

    function fmtClock(time: any): string {
      if (typeof time !== 'number' || !isFinite(time) || time <= 0) return '—'
      const d = new Date(time)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function stopReasonLabel(reason: any): string {
      const value = String(reason || '')
      if (value === 'error') return usageCopy.failed
      if (value === 'aborted') return usageCopy.aborted
      return usageCopy.ok
    }

    function stopReasonColor(reason: any): string {
      const value = String(reason || '')
      if (value === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (value === 'aborted') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    const usageStyles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      spacer: { flex: '1 1 auto' },
      meta: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '8px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '8px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: 0
      },
      cardLabel: { fontSize: '12px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      cardValue: { fontSize: '19px', lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      cardHint: { fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)', opacity: '0.8' },
      panel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '8px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      },
      panelTitle: { fontSize: '12px', lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      chart: { display: 'block', width: '100%' },
      legend: { display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      dot: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', marginRight: '4px' },
      tableWrap: { overflowX: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap'
      },
      td: {
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-primary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap'
      },
      right: { textAlign: 'right' },
      mono: { fontVariantNumeric: 'tabular-nums' },
      empty: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' },
      error: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 }
    }

    function MetricCard(props: any) {
      return h(
        'div',
        { style: usageStyles.card },
        h('div', { style: usageStyles.cardLabel }, props.label),
        h('div', { style: usageStyles.cardValue }, props.value),
        props.hint ? h('div', { style: usageStyles.cardHint }, props.hint) : null
      )
    }

    function UsageTable(props: any) {
      const columns = props.columns || []
      const rows = props.rows || []
      if (rows.length === 0) return h('div', { style: usageStyles.empty }, props.empty || usageCopy.noData)
      return h(
        'div',
        { style: usageStyles.tableWrap },
        h(
          'table',
          { style: usageStyles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              columns.map(column =>
                h(
                  'th',
                  {
                    key: column.key,
                    style: Object.assign({}, usageStyles.th, column.align === 'right' ? usageStyles.right : null)
                  },
                  column.label
                )
              )
            )
          ),
          h(
            'tbody',
            null,
            rows.map((row: any, index: number) =>
              h(
                'tr',
                { key: index },
                columns.map(column =>
                  h(
                    'td',
                    {
                      key: column.key,
                      style: Object.assign(
                        {},
                        usageStyles.td,
                        usageStyles.mono,
                        column.align === 'right' ? usageStyles.right : null
                      )
                    },
                    column.render ? column.render(row) : String(row[column.key] === undefined ? '' : row[column.key])
                  )
                )
              )
            )
          )
        )
      )
    }

    /**
     * Two polylines over the same bucket axis: request volume, with failures
     * drawn in the error color so a bad window is visible without reading axes.
     */
    function UsageTrend(props: any) {
      const points = Array.isArray(props.points) ? props.points : []
      if (points.length === 0) return h('div', { style: usageStyles.empty }, usageCopy.noData)
      const width = 600
      const height = 110
      const pad = 6
      const maxRequests = Math.max(1, ...points.map((p: any) => Number(p.requests) || 0))
      const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0
      const xOf = (index: number) => pad + index * step
      const yOf = (value: number) => height - pad - (value / maxRequests) * (height - pad * 2)
      const pathOf = (key: string) =>
        points
          .map((point: any, index: number) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(Number(point[key]) || 0).toFixed(1)}`)
          .join(' ')
      const first = points[0]
      const last = points[points.length - 1]
      return h(
        'div',
        null,
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width: '100%', height: '110px', preserveAspectRatio: 'none', style: usageStyles.chart },
          h('path', { d: pathOf('requests'), fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: '2' }),
          h('path', { d: pathOf('errors'), fill: 'none', stroke: 'var(--dsw-alias-state-error-primary)', strokeWidth: '1.5' })
        ),
        h(
          'div',
          { style: usageStyles.legend },
          h('span', null, h('i', { style: Object.assign({}, usageStyles.dot, { background: 'var(--dsw-alias-brand-primary)' }) }), `${usageCopy.requests} (max ${fmtInt(maxRequests)})`),
          h('span', null, h('i', { style: Object.assign({}, usageStyles.dot, { background: 'var(--dsw-alias-state-error-primary)' }) }), usageCopy.errors),
          h('span', { style: usageStyles.spacer }),
          h('span', null, `${fmtClock(first.time)} → ${fmtClock(last.time)}`)
        )
      )
    }

    /** Settings → usage page. Reads the host routes; holds no accounting logic. */
    function AntigravityUsagePanel(props: any) {
      const [range, setRange] = React.useState('24h')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [backfilling, setBackfilling] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(
        async (target?: string) => {
          const next = target || range
          setLoading(true)
          try {
            const payload = await getJson(`${USAGE_ROUTE}/overview?range=${encodeURIComponent(next)}`)
            setData(payload)
            setError(null)
          } catch (cause) {
            setError(cause.message)
          } finally {
            setLoading(false)
          }
        },
        [range]
      )

      React.useEffect(() => {
        load(range)
      }, [range])

      React.useEffect(() => {
        const timer = setInterval(() => {
          load()
        }, USAGE_REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      const runBackfill = React.useCallback(
        async (auto?: boolean) => {
          setBackfilling(true)
          setNotice(auto === true ? usageCopy.autoScan : null)
          try {
            const result = await getJson(`${USAGE_ROUTE}/backfill`, { method: 'POST' })
            setNotice(
              result && Number(result.imported) > 0
                ? `${usageCopy.backfillDone} ${fmtInt(result.imported)}`
                : auto === true
                  ? null
                  : usageCopy.backfillEmpty
            )
          } catch (cause) {
            setNotice(`${usageCopy.backfill}: ${cause.message}`)
          } finally {
            setBackfilling(false)
            load()
          }
        },
        [load]
      )

      /** One automatic scan per panel mount. */
      const autoScanned = React.useRef(false)

      /**
       * Opening the panel is itself the request to account for history, so it
       * happens on every open rather than behind a button or a cooldown. That
       * stays cheap because the host skips every session file whose revision
       * has not changed — the rescan normally decompresses nothing at all.
       */
      React.useEffect(() => {
        if (data === null || autoScanned.current) return
        const snapshot = data.status
        if (!snapshot || snapshot.backfill !== true || snapshot.authenticated !== true) return
        autoScanned.current = true
        runBackfill(true)
      }, [data, runBackfill])

      const overview = (data && data.overview) || null
      const lifetime = (data && data.lifetime) || null
      const status = (data && data.status) || null
      const tokens = (overview && overview.tokens) || {}
      const cost = (overview && overview.cost) || {}

      const rangeButtons = ((data && data.ranges) || ['1h', '24h', '7d', '30d', '90d', 'all']).map((value: string) =>
        h(
          Button,
          {
            key: value,
            variant: value === range ? 'primary' : 'outline',
            size: 'sm',
            disabled: loading,
            onClick: () => setRange(value)
          },
          (RANGE_LABELS as any)[value] || value
        )
      )

      const toolRow = h(
        'div',
        { style: usageStyles.toolbar },
        rangeButtons,
        h('span', { style: usageStyles.spacer }),
        status
          ? h(
              'span',
              { style: usageStyles.meta },
              `${usageCopy.recorded} ${fmtInt(status.total)} · ${usageCopy.span} ${fmtClock(status.firstTime)} → ${fmtClock(status.lastTime)}`
            )
          : null,
        status && status.backfill === true
          ? h(
              Button,
              { variant: 'outline', size: 'sm', disabled: backfilling || loading, onClick: runBackfill },
              backfilling ? usageCopy.backfilling : usageCopy.backfill
            )
          : null,
        h(
          Button,
          { variant: 'outline', size: 'sm', disabled: loading, onClick: () => load() },
          loading ? usageCopy.refreshing : usageCopy.refresh
        )
      )

      if (error) {
        return h(
          'div',
          { style: usageStyles.wrap },
          h('div', { style: usageStyles.panelTitle }, usageCopy.title),
          toolRow,
          h('p', { style: usageStyles.error }, error)
        )
      }

      if (data === null) {
        return h(
          'div',
          { style: usageStyles.wrap },
          h('div', { style: usageStyles.panelTitle }, usageCopy.title),
          h('div', { style: usageStyles.empty }, usageCopy.loading)
        )
      }

      // "Empty in this window" and "nothing ever recorded" are different facts,
      // and reporting the second while the first is true is exactly the trap
      // the reference implementation's fixed 24h default walks into.
      if (overview.requests === 0 && (lifetime === null || lifetime.requests === 0)) {
        return h(
          'div',
          { style: usageStyles.wrap },
          h('div', { style: usageStyles.panelTitle }, usageCopy.title),
          toolRow,
          notice ? h('div', { style: usageStyles.meta }, notice) : null,
          h('div', { style: usageStyles.empty }, usageCopy.empty)
        )
      }

      const modelColumns = [
        { key: 'model', label: usageCopy.model, render: (row: any) => row.label },
        { key: 'calls', label: usageCopy.calls, align: 'right', render: (row: any) => fmtInt(row.overview.requests) },
        { key: 'input', label: usageCopy.input, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.inputTokens) },
        { key: 'output', label: usageCopy.output, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.outputTokens) },
        { key: 'cache', label: usageCopy.cacheRead, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.cacheReadTokens) },
        { key: 'rate', label: usageCopy.cacheRate, align: 'right', render: (row: any) => fmtPct(row.overview.cacheRate) },
        { key: 'ttft', label: usageCopy.ttft, align: 'right', render: (row: any) => fmtMs(row.overview.avgTtftMs) },
        { key: 'cost', label: usageCopy.cost, align: 'right', render: (row: any) => fmtCost(row.overview.cost.total) }
      ]

      const projectColumns = [
        { key: 'project', label: usageCopy.project, render: (row: any) => row.label },
        { key: 'calls', label: usageCopy.calls, align: 'right', render: (row: any) => fmtInt(row.overview.requests) },
        { key: 'tokens', label: usageCopy.tokens, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.totalTokens) },
        { key: 'rate', label: usageCopy.cacheRate, align: 'right', render: (row: any) => fmtPct(row.overview.cacheRate) },
        { key: 'errors', label: usageCopy.errors, align: 'right', render: (row: any) => fmtPct(row.overview.errorRate) },
        { key: 'cost', label: usageCopy.cost, align: 'right', render: (row: any) => fmtCost(row.overview.cost.total) }
      ]

      // Accounts read like projects, only the first column changes meaning: the
      // question is "which Google account spent this" now that there can be
      // several. `(unknown)` is where pre-registry rows land.
      const accountColumns = [
        { key: 'account', label: usageCopy.account, render: (row: any) => row.label },
        { key: 'calls', label: usageCopy.calls, align: 'right', render: (row: any) => fmtInt(row.overview.requests) },
        { key: 'tokens', label: usageCopy.tokens, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.totalTokens) },
        { key: 'rate', label: usageCopy.cacheRate, align: 'right', render: (row: any) => fmtPct(row.overview.cacheRate) },
        { key: 'errors', label: usageCopy.errors, align: 'right', render: (row: any) => fmtPct(row.overview.errorRate) },
        { key: 'cost', label: usageCopy.cost, align: 'right', render: (row: any) => fmtCost(row.overview.cost.total) }
      ]

      // 会话维度跟项目维度同形，只换第一列的标签来源（sessionLabel 已把长 id 缩短）。
      const sessionColumns = [
        { key: 'session', label: usageCopy.session, render: (row: any) => row.label },
        { key: 'calls', label: usageCopy.calls, align: 'right', render: (row: any) => fmtInt(row.overview.requests) },
        { key: 'tokens', label: usageCopy.tokens, align: 'right', render: (row: any) => fmtTokens(row.overview.tokens.totalTokens) },
        { key: 'rate', label: usageCopy.cacheRate, align: 'right', render: (row: any) => fmtPct(row.overview.cacheRate) },
        { key: 'errors', label: usageCopy.errors, align: 'right', render: (row: any) => fmtPct(row.overview.errorRate) },
        { key: 'cost', label: usageCopy.cost, align: 'right', render: (row: any) => fmtCost(row.overview.cost.total) }
      ]

      const recentColumns = [
        { key: 'time', label: usageCopy.time, render: (row: any) => fmtClock(row.time) },
        { key: 'model', label: usageCopy.model, render: (row: any) => row.model },
        { key: 'tokens', label: usageCopy.tokens, align: 'right', render: (row: any) => fmtTokens(row.tokens.totalTokens) },
        { key: 'duration', label: usageCopy.duration, align: 'right', render: (row: any) => fmtMs(row.durationMs) },
        { key: 'cost', label: usageCopy.cost, align: 'right', render: (row: any) => fmtCost(row.cost.total) },
        {
          key: 'status',
          label: usageCopy.status,
          render: (row: any) =>
            h('span', { style: { color: stopReasonColor(row.stopReason) } }, stopReasonLabel(row.stopReason))
        }
      ]

      return h(
        'div',
        { style: usageStyles.wrap },
        h('div', { style: usageStyles.panelTitle }, usageCopy.title),
        toolRow,
        notice ? h('div', { style: usageStyles.meta }, notice) : null,
        // The all-time total sits above the range-scoped cards on purpose: it
        // answers "how much in total" without the reader having to widen the
        // range and read the same cards back out.
        lifetime !== null && lifetime.requests > 0
          ? h(
              'div',
              { style: usageStyles.panel },
              h(
                'div',
                { style: usageStyles.legend },
                h('span', { style: usageStyles.panelTitle }, usageCopy.lifetime),
                h('span', null, `${fmtInt(lifetime.requests)} ${usageCopy.calls}`),
                h('span', null, `${fmtTokens(lifetime.tokens.totalTokens)} ${usageCopy.tokens}`),
                h('span', null, fmtCost(lifetime.cost.total)),
                h('span', { style: usageStyles.spacer }),
                h('span', null, `${fmtClock(lifetime.firstTime)} → ${fmtClock(lifetime.lastTime)}`)
              )
            )
          : null,
        overview.requests === 0 && lifetime !== null
          ? h(
              'div',
              { style: usageStyles.empty },
              `${usageCopy.rangeEmptyPrefix}${fmtInt(lifetime.requests)}${usageCopy.rangeEmptySuffix}`
            )
          : null,
        status && status.enabled === false ? h('div', { style: usageStyles.empty }, usageCopy.disabled) : null,
        h(
          'div',
          { style: usageStyles.grid },
          h(MetricCard, { key: 'r', label: usageCopy.requests, value: fmtInt(overview.requests), hint: `${usageCopy.errors} ${fmtPct(overview.errorRate)}` }),
          h(MetricCard, { key: 't', label: usageCopy.totalTokens, value: fmtTokens(tokens.totalTokens) }),
          h(MetricCard, { key: 'c', label: usageCopy.cacheRate, value: fmtPct(overview.cacheRate), hint: `节省 ${fmtPct(overview.cacheSavings)}` }),
          h(MetricCard, { key: 'cost', label: usageCopy.cost, value: fmtCost(cost.total), hint: usageCopy.costHint })
        ),
        h(
          'div',
          { style: usageStyles.grid },
          h(MetricCard, { key: 'i', label: usageCopy.input, value: fmtTokens(tokens.inputTokens) }),
          h(MetricCard, { key: 'o', label: usageCopy.output, value: fmtTokens(tokens.outputTokens) }),
          h(MetricCard, { key: 'cr', label: usageCopy.cacheRead, value: fmtTokens(tokens.cacheReadTokens) }),
          h(MetricCard, { key: 'ttft', label: usageCopy.avgTtft, value: fmtMs(overview.avgTtftMs) }),
          h(MetricCard, { key: 'd', label: usageCopy.avgDuration, value: fmtMs(overview.avgDurationMs) }),
          h(MetricCard, {
            key: 'tps',
            label: usageCopy.throughput,
            value: overview.tokensPerSecond === null ? '—' : `${overview.tokensPerSecond.toFixed(1)} tok/s`
          })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.trend),
          h(UsageTrend, { points: data.series })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.byModel),
          h(UsageTable, { columns: modelColumns, rows: data.models })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.byProject),
          h(UsageTable, { columns: projectColumns, rows: data.projects })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.byAccount),
          h(UsageTable, { columns: accountColumns, rows: data.accounts || [], empty: usageCopy.noData })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.bySession),
          h(UsageTable, { columns: sessionColumns, rows: data.sessions || [], empty: usageCopy.noData })
        ),
        h(
          'div',
          { style: usageStyles.panel },
          h('div', { style: usageStyles.panelTitle }, usageCopy.recent),
          h(UsageTable, {
            columns: recentColumns,
            rows: (data.recent || []).slice(0, 12),
            empty: usageCopy.noData
          }),
          h('div', { style: usageStyles.meta }, usageCopy.note)
        )
      )
    }

    const inject = ['slots']

    function apply(ctx: any) {
      ctx.slots.inject('settings.models.provider-card', () =>
        ctx.slots.register(
          {
            name: 'settings.models.provider-card',
            key: 'llm-antigravity'
          },
          AntigravityCard
        )
      )
      /**
       * The usage page is offered only to a user who has an Antigravity
       * account. `settings.section` has no per-entry visibility switch, so the
       * gate *is* the registration: probe the host once, register only on a
       * true answer, and keep the probe cancelable so an unmounting fiber can
       * never leave a late registration behind.
       */
      ctx.slots.inject('settings.section', () => {
        let dispose = null
        let cancelled = false
        probeAccount().then(authenticated => {
          if (cancelled || !authenticated) return
          dispose = ctx.slots.register(
            {
              name: 'settings.section',
              id: 'antigravity-usage',
              order: 30,
              label: () => usageCopy.title
            },
            AntigravityUsagePanel
          )
        })
        return () => {
          cancelled = true
          if (typeof dispose === 'function') dispose()
        }
      })
    }

    /**
     * Ask the host whether an Antigravity account is installed.
     *
     * Any failure means "no": a headless surface, an older build without the
     * usage routes, or a signed-out user all end up with no panel instead of a
     * broken one.
     */
    async function probeAccount(): Promise<boolean> {
      try {
        const status = await getJson(`${USAGE_ROUTE}/status`)
        return status != null && status.authenticated === true
      } catch {
        return false
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.AntigravityCard = AntigravityCard
    exports.AntigravityUsagePanel = AntigravityUsagePanel
    return module.exports
  }
})
