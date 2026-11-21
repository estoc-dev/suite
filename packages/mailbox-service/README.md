# @estoc/mailbox-service

Running a mailbox service. What it serves, and the client that reaches it,
are in `src/server.ts` and `src/client.ts`.

## Running with Node

`src/main.ts` runs a service in Node, with all it keeps in one SQLite file.
Node runs the TypeScript sources as they are, so a checkout of the
repository with its dependencies installed is all it takes:

```sh
git clone https://github.com/estoc-dev/suite.git && cd suite
pnpm install --frozen-lockfile
export MAILBOX_DATABASE=/var/lib/mailbox/service.db
node packages/mailbox-service/src/main.ts setup
```

`main.ts setup` makes the file that the environment names, a SQLite file
that its owner alone reads, and refuses where the file is there. A setup
that fails once it has made the file leaves it, so remove the file before
running it again. The database holds a new Ed25519 Secret Key of
`@estoc/identity`, the root of the service's identity, and the first
identity version, which the root signs, with a record of it, so the service
signs as that identity from then on. It prints the identifier of the
identity. The service is named by that identifier, so a lost key is a lost
service: keep a copy of the database offline. The key is in the file
unencrypted, so whoever reads the file or a copy of it can sign as the
service: keep each where its owner alone reads it.

`main.ts` takes its settings from the environment:

| Variable | Setting |
|---|---|
| `MAILBOX_ORIGIN` | the origin the service is reached at, such as `https://mail.example` |
| `MAILBOX_DATABASE` | the path of the SQLite file that holds the store, with the key of the service in it, the accounts and the mailboxes |
| `MAILBOX_PORT` | the port it listens at |
| `MAILBOX_HOST` | the address it listens at; 127.0.0.1 unless set |
| `MAILBOX_RETENTION` | the retention that the offer of mailboxes names, in milliseconds; 30 days unless set |
| `MAILBOX_QUOTA` | its quota, in bytes; 64 MiB unless set |
| `MAILBOX_SIZE` | its size, in bytes; 1 MiB unless set |

It signs as the identity whose versions its database records, by its root,
which each version lists. It refuses to start without its database, when
the database records versions of no identity or of more than one, or when
it does not hold the Secret Key of the root. Once it
serves, it writes a line with its origin, where it listens and the
identifier of its identity. It speaks plain
HTTP, for a proxy in front of it that holds the TLS certificate. It writes a line
for each request, with its method, its status and how long it took. On
SIGTERM it takes no more requests, answers those it took, and closes the
files.

A body comes in as the service reads it, a chunk at a time. Once a body goes
past the service's limit for it, the service reads no more chunks of it and
the rest is dropped, so a large body is not held in memory.

Under systemd, with Caddy in front:

```ini
# /etc/systemd/system/mailbox.service
[Unit]
Description=Mailbox service
After=network.target

[Service]
User=mailbox
WorkingDirectory=/srv/suite
ExecStart=/usr/bin/node packages/mailbox-service/src/main.ts
Environment=MAILBOX_ORIGIN=https://mail.example
Environment=MAILBOX_DATABASE=/var/lib/mailbox/service.db
Environment=MAILBOX_PORT=8080
Restart=always

[Install]
WantedBy=multi-user.target
```

```
# /etc/caddy/Caddyfile
mail.example {
	reverse_proxy 127.0.0.1:8080
}
```

The database can be backed up while the service runs, with SQLite's online
backup. The backup holds the key of the service as the database does, so it
goes in a folder that its owner alone enters, written as a new file that its
owner alone reads, which then takes the place of the backup before it:

```sh
install -d -m 700 /var/backups/mailbox
(umask 077 && sqlite3 /var/lib/mailbox/service.db ".backup /var/backups/mailbox/service.db.new")
mv /var/backups/mailbox/service.db.new /var/backups/mailbox/service.db
```

SQLite keeps the mode of a file it writes over, so a backup made before in
a file that others read stays readable to them: remove it.

Restore it with the service stopped. An account that the database holds
with no record of its acknowledgement gets a new acknowledgement when its
acceptance is posted again.

`src/smoke.ts` checks a running service:

```sh
node packages/mailbox-service/src/smoke.ts https://mail.example
```

It opens a mailbox there under the account of a test identity, sends it a
message, and picks the message up. The identity and the mailbox's key are
fixed, so each run reaches the same account. While the service offers
mailboxes on the same terms, each run reaches the same mailbox too. A change
to `MAILBOX_RETENTION`, `MAILBOX_QUOTA` or `MAILBOX_SIZE` makes another offer,
under which the next run opens another mailbox. Anyone who reads `smoke.ts`
can sign as that identity, which is all right for an account that only tests
a service.

## Running in Docker

`Dockerfile` builds an image of the service, from the root of the
repository:

```sh
docker build -f packages/mailbox-service/Dockerfile -t mailbox-service .
```

The image runs `main.ts` as the `node` user. It listens at port 8080 of the
container, for a proxy on the same network, and keeps its database in
`/data`. The other settings come from the environment
as above. Arguments go to `main.ts`, so the service is set up with:

```sh
docker run --rm -v mailbox:/data mailbox-service setup
```

With Docker Compose, from a folder that holds a checkout of the repository
at `suite`:

```yaml
services:
  mailbox:
    build:
      context: suite
      dockerfile: packages/mailbox-service/Dockerfile
    restart: unless-stopped
    environment:
      MAILBOX_ORIGIN: https://mail.example
    volumes:
      - data:/data

volumes:
  data:
```

`docker compose run --rm mailbox setup` sets up the service in that volume, and `docker compose up -d --build` serves the
checkout as it is after a pull.
