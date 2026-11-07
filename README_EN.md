# agenda-link

<p align="center">
  <img src="./apps/web/public/logo.svg" height="112" alt="agenda-link" />
</p>

<p align="center">One booking. Meeting and calendar in sync.</p>

<p align="center">
  <a href="./README.md">中文</a> ·
  English
</p>

<p align="center">
  <a href="https://github.com/HawkonS/agenda-link/actions/workflows/checks.yml"><img src="https://github.com/HawkonS/agenda-link/actions/workflows/checks.yml/badge.svg?branch=main" alt="Checks" /></a>
  <a href="https://github.com/HawkonS/agenda-link/actions/workflows/security.yml"><img src="https://github.com/HawkonS/agenda-link/actions/workflows/security.yml/badge.svg?branch=main" alt="Security" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

## Overview

agenda-link is a meeting and calendar workspace for internal teams. It brings directories, meeting bookings, calendar events and recording access into one place, reducing duplicate work and manual synchronization across platforms.

The system integrates Feishu and Tencent Meeting. It browses and imports directory data, books and manages meetings, creates and maintains Feishu calendar events, and keeps linked events in sync when a meeting is rescheduled. Feishu directory data can also be synchronized to Tencent Meeting.

Built with React, NestJS and SQLite, agenda-link runs as a single service with a local database and is designed for internal or single-server deployments.

## Features

- **One workspace**: upcoming meetings, quick booking, joining and recordings on desktop and mobile.
- **Directory**: browse Feishu and Tencent Meeting departments and people, with search and selective import.
- **Directory sync**: preview and sync Feishu departments and people to Tencent Meeting, with scheduling and change-aware writes.
- **Meeting booking**: choose platform, time, attendees and host, then manage meeting numbers, links and status.
- **Meeting editing**: Tencent Meeting supports editing the subject, time, attendees, recording settings and calendar template, with linked events updated in the same save.
- **Calendar collaboration**: create Feishu events, invite attendees, apply templates and render meeting details.
- **Recording access**: review recording status and open playback from the meeting detail.
- **Cancellation and completion**: cancel a meeting with its linked event, or finish it while keeping its record and audit trail.
- **Roles and audit**: administrators, operators and regular users; key actions are recorded.
- **Administration**: connections, permissions, sync schedules, templates, logs, backups and upgrades.

## Supported platforms

| Capability | Feishu | Tencent Meeting |
| --- | --- | --- |
| Directory | Browse, search, import | Browse, search, import; receives Feishu sync |
| Meetings | Book, query, cancel, recording details | Book, query, reschedule, cancel, cloud recording |
| Calendar | Linked events, attendees, templates, updates | — |
| Login | Optional Feishu login | — |

A meeting can be booked alone or together with a Feishu calendar event. The event attaches the existing meeting link; retrying a failed calendar step does not create another meeting.

## Quick start

Requirements: macOS or Linux, Git, Bash, Node.js **22.12+**, npm 10+.

```bash
git clone https://github.com/HawkonS/agenda-link.git
cd agenda-link
./run.sh
```

Open <http://127.0.0.1:15173>. The first run creates the `hawkon` administrator; read `.runtime/initial-admin-password` and change it after signing in.

Stop with `Ctrl+C` or `./stop.sh`.

## Configuration

Runtime settings live in `agenda-link.properties`, generated on first start. The database is stored at `data/agenda-link.sqlite`, with logs under `logs/`. Set `AGENDA_LINK_WORKSPACE` to use another data directory.

Configure Feishu and Tencent Meeting connections under **System Settings → Configuration**. Connection forms are declared by backend components; secrets are encrypted at rest, and only administrators can save or test connections.

Use HTTPS in production and set the correct public base URL so meeting links in calendar events are reachable.

## Deployment

```bash
sudo ./tools/manage_service.sh install
sudo ./tools/manage_service.sh start
sudo ./tools/manage_service.sh upgrade
sudo ./tools/manage_service.sh backup
```

Docker Compose, Nginx and log rotation examples are included:

- [Docker Compose](./tools/compose.yml)
- [Nginx configuration](./tools/nginx/agenda-link.conf.example)
- [Log rotation](./tools/logrotate/agenda-link)

The application uses SQLite and runs as a single instance; do not start multiple replicas against the same data directory.

## Development

```bash
./run.sh --dev      # backend watch mode + Vite dev server
npm run check       # lint, typecheck, tests, build and repository audit
npm run test:e2e    # isolated end-to-end run; requires local Chrome
```

## FAQ

**How do I reset the administrator password?**

```bash
./tools/reset-admin-password.sh
./tools/reset-admin-password.sh --enable
```

**The service will not start or the port is busy.**

Check whether ports `15173` and `18480` are in use, and confirm Node.js is version 22.12 or newer. Detailed logs are under `logs/`.

## Security

- Do not commit `agenda-link.properties`, `data/`, `.runtime/`, `logs/` or backups.
- Connection secrets are encrypted; rotating `auth.jwt-secret` makes saved credentials unreadable and invalidates current sessions.
- Use HTTPS in production and restrict access to administrative endpoints, backup directories and the database file.

## License

Copyright 2026 HawkonS.

Licensed under the [Apache License 2.0](./LICENSE).
