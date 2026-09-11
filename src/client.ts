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
     * Browser half of dsh-antigravity: the provider card's sign-in area in
     * Settings → Models.
     *
     * It renders inside the `settings.models.provider-card` keyed slot for the
     * `llm-antigravity` settings namespace and talks to the host over the
     * loopback routes the host half registers. No secrets cross the wire: the
     * host owns the OAuth exchange and stores the grant in `ctx.credentials`.
     *
     * Every element is built with `React.createElement`, whose trailing
     * arguments are children. The automatic `jsx`/`jsxs` runtime instead reads
     * children from `props.children` and treats its third argument as the key,
     * so calling it in `createElement` shape silently renders empty elements.
     */
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
          failed: '操作失败'
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
          failed: 'Request failed'
        }

    async function call(path: string, init?: RequestInit): Promise<any> {
      const response = await fetch(`${ROUTE}${path}`, {
        headers: { accept: 'application/json' },
        ...init
      })
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
      link: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-brand-primary)' }
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

      const authenticated = status != null && status.authenticated === true
      const pending = status != null && status.pending === true
      const expired = status != null && status.expired === true
      // The host records why an attempt ended without a grant (cancelled,
      // timed out, exchange failure). Without rendering it the card silently
      // drops back to "not signed in" and the human is left guessing, so
      // surface the reason unless the status line already says it.
      const notice =
        status != null && !authenticated && !pending && !expired && status.error ? String(status.error) : null
      const minutes =
        status == null || status.timeLeftSeconds == null
          ? null
          : Math.max(0, Math.round(status.timeLeftSeconds / 60))

      const identity = authenticated
        ? [copy.signedIn, status.email, status.projectId ? `${copy.project}: ${status.projectId}` : null]
            .filter(Boolean)
            .join(' · ')
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
        h('span', { key: 'label', style: styles.label }, identity),
        minutes !== null && authenticated
          ? h('span', { key: 'exp', style: styles.hint }, `${copy.expires} ~${minutes} ${copy.minutes}`)
          : null
      )

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
            authenticated
              ? h(
                  Button,
                  {
                    key: 'out',
                    variant: 'outline',
                    size: 'sm',
                    disabled: busy,
                    onClick: () => run(() => call('/logout', { method: 'POST' }))
                  },
                  copy.signOut
                )
              : h(
                  Button,
                  {
                    key: 'in',
                    variant: 'primary',
                    size: 'sm',
                    disabled: busy,
                    onClick: startLogin
                  },
                  copy.signIn
                )
          )

      return h(
        'div',
        { style: styles.wrap, 'data-dsh-antigravity': 'card' },
        head,
        actions,
        notice ? h('p', { key: 'notice', style: styles.hint }, notice) : null,
        error ? h('p', { key: 'error', style: styles.error }, `${copy.failed}: ${error}`) : null
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
    }

    exports.apply = apply
    exports.inject = inject
    exports.AntigravityCard = AntigravityCard
    return module.exports
  }
})
