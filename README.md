# nostream-system-test

System testing for Nostream.

## Sintel E2E (keep stack running)

Run the full Sintel flow and keep Docker services up after the test:

```bash
npm run test:sintel:keep
```

Equivalent explicit command:

```bash
KEEP_STACK=1 npm run test:sintel
```

You can also use the helper script:

```bash
./scripts/run-sintel-keep.sh
```

## Open UI in browser container

If needed, start/open UI + Selenium browser:

```bash
./scripts/start-ui-browser.sh
```

Then open:

- App root: `http://nostream-ui:5173/`
- Movie view: `http://nostream-ui:5173/view/imdb/tt1727587`
- VNC: `http://localhost:7900/?autoconnect=1&resize=scale`

## Post-check: relay has movie asset event

Before debugging UI playback, verify that `kind:2003` asset events exist in relay:

```bash
node -e "import('nostr-tools').then(async ({SimplePool}) => { const p=new SimplePool(); const r=['ws://127.0.0.1:7777/']; const evts=await p.querySync(r,{kinds:[2003],limit:5}); console.log('kind2003',evts.length); console.log(evts.map(e=>({id:e.id,tags:e.tags.filter(t=>t[0]==='x'||t[0]==='i'||t[0]==='imdb')}))); p.close(r); })"
```

If this prints `kind2003 0`, no asset is registered in the current relay DB, so the movie page will not render a playable asset.
