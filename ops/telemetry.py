"""Bounded, read-only observations of this exact Tavern Compose project."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import re

from aiohttp import web

COMPONENTS = {'init', 'tavern-web', 'tavern-api', 'synapse', 'postgres', 'operations', 'integrations', 'coturn', 'livekit', 'rtc-auth'}
LEVELS = {'ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'UNKNOWN'}
MAX_BYTES = 256 * 1024


def filters(query):
    if set(query) - {'component', 'severity', 'minutes', 'limit', 'search'}:
        raise ValueError('Unknown log filter.')
    component, severity, search = query.get('component', 'all'), query.get('severity', 'ALL'), query.get('search', '')
    if component not in COMPONENTS | {'all'} or severity not in LEVELS or len(search) > 120 or any(ord(c) < 32 for c in search):
        raise ValueError('Choose a known component, severity, and search of at most 120 characters.')
    try:
        minutes, limit = int(query.get('minutes', '15')), int(query.get('limit', '200'))
    except (ValueError, TypeError):
        raise ValueError('Log window and line limit must be numbers.') from None
    if not 1 <= minutes <= 1440 or not 1 <= limit <= 2000:
        raise ValueError('Choose a log window of 1–1440 minutes and 1–2000 lines.')
    return {'component': component, 'severity': severity, 'minutes': minutes, 'limit': limit, 'search': search}


def log_row(line, component):
    line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)[:16384]
    timestamp, _, message = line.partition(' ')
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT\S+', timestamp):
        timestamp, message = None, line
    level = 'UNKNOWN'
    if message.startswith('{'):
        try:
            value = json.loads(message)
            if isinstance(value, dict):
                level = str(value.get('level') or value.get('severity') or 'UNKNOWN').upper()
                message = str(value.get('message', value.get('msg', message)))
        except ValueError:
            pass
    if level == 'UNKNOWN':
        match = re.search(r'\b(ERROR|ERR|FATAL|CRITICAL|WARNING|WARN|INFO|DEBUG|TRACE)\b', message, re.I)
        if match:
            level = match[1].upper()
    level = {'ERR': 'ERROR', 'FATAL': 'ERROR', 'CRITICAL': 'ERROR', 'WARNING': 'WARN', 'TRACE': 'DEBUG'}.get(level, level)
    if level not in LEVELS - {'ALL'}:
        level = 'UNKNOWN'
    message = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', message)[:16384]
    message = ''.join(character if ord(character) >= 32 or character in '\t\n' else '\ufffd' for character in message)
    message = re.sub(r'(?i)\bBearer\s+[^\s,;"\']+', 'Bearer [redacted]', message)
    message = re.sub(r'''(?ix)(\b(?:access_token|refresh_token|csrf_token|token|password|secret|api_key|hmac|registration_shared_secret|recovery_key|recovery_code|authorization|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)''', r'\1[redacted]', message)
    message = re.sub(r'(?i)(\b(?:set-cookie|cookie|authorization)\s*:\s*).*', r'\1[redacted]', message)
    message = re.sub(r'''(?ix)(/api/invitations/(?:preview|accept)/)[^\s/?\#"'<>]+''', r'\1[redacted]', message)
    message = re.sub(r'''(?ix)([?&]invite=)[^\s&"'<>]+''', r'\1[redacted]', message)
    return {'timestamp': timestamp, 'component': component, 'severity': level, 'message': message}


def metrics(value):
    memory = value.get('memory_stats') or {}
    usage, limit = memory.get('usage'), memory.get('limit')
    if isinstance(usage, (int, float)):
        usage = max(0, usage - (memory.get('stats', {}).get('inactive_file', memory.get('stats', {}).get('cache', 0)) or 0))
    cpu, prior = value.get('cpu_stats') or {}, value.get('precpu_stats') or {}
    total, previous = cpu.get('cpu_usage', {}).get('total_usage'), prior.get('cpu_usage', {}).get('total_usage')
    system, old_system = cpu.get('system_cpu_usage'), prior.get('system_cpu_usage')
    count = cpu.get('online_cpus') or len(cpu.get('cpu_usage', {}).get('percpu_usage') or [])
    percent = None
    if all(isinstance(n, (int, float)) for n in (total, previous, system, old_system)) and system > old_system and total >= previous and count:
        percent = round((total - previous) / (system - old_system) * count * 100, 2)
    networks = value.get('networks')
    return {'cpuPercent': percent, 'memoryBytes': usage if isinstance(usage, (int, float)) else None,
            'memoryLimitBytes': limit if isinstance(limit, (int, float)) else None,
            'memoryPercent': round(usage / limit * 100, 2) if isinstance(usage, (int, float)) and isinstance(limit, (int, float)) and limit > 0 else None,
            'pids': value.get('pids_stats', {}).get('current'),
            'receivedBytes': sum(item.get('rx_bytes', 0) for item in networks.values()) if isinstance(networks, dict) else None,
            'sentBytes': sum(item.get('tx_bytes', 0) for item in networks.values()) if isinstance(networks, dict) else None}


class Telemetry:
    def __init__(self, operator):
        self.operator = operator

    def inventory(self):
        result = {}
        for container in self.operator.engine.containers.list(all=True, filters={'label': ['com.docker.compose.project=' + self.operator.project, 'io.tavern.managed=true']}):
            container.reload()
            labels = container.attrs.get('Config', {}).get('Labels') or {}
            component = labels.get('com.docker.compose.service')
            if labels.get('com.docker.compose.project') != self.operator.project or labels.get('io.tavern.managed') != 'true' or component not in COMPONENTS or labels.get('io.tavern.rollback') or re.search(r'-rollback-[a-f0-9]{12}$', container.name):
                continue
            if component in result:
                raise ValueError('Duplicate managed services exist. Resolve deployment state before reading logs.')
            result[component] = container
        return result

    def read_logs(self, selected):
        containers = self.inventory()
        components = sorted(containers)
        if selected['component'] != 'all':
            if selected['component'] not in containers:
                return {'available': True, 'rows': [], 'components': sorted(containers), 'unavailable': [selected['component']], 'truncated': False, 'filters': selected}
            containers = {selected['component']: containers[selected['component']]}
        rows, unavailable, truncated = [], [], False
        since = datetime.now(timezone.utc) - timedelta(minutes=selected['minutes'])
        for component, container in containers.items():
            stream = None
            try:
                stream = container.logs(stdout=True, stderr=True, timestamps=True, since=since, tail=selected['limit'], follow=False, stream=True)
                raw = bytearray()
                for chunk in stream:
                    remaining = MAX_BYTES - len(raw)
                    raw.extend(chunk[:remaining])
                    if len(chunk) > remaining or len(raw) == MAX_BYTES:
                        truncated = True
                        break
                lines = raw.decode(errors='replace').splitlines()
                truncated = truncated or len(lines) >= selected['limit']
                for line in lines:
                    row = log_row(line, component)
                    if (selected['severity'] == 'ALL' or row['severity'] == selected['severity']) and selected['search'].casefold() in row['message'].casefold():
                        rows.append(row)
            except Exception:
                unavailable.append(component)
            finally:
                if stream is not None and hasattr(stream, 'close'):
                    stream.close()
        rows.sort(key=lambda row: row['timestamp'] or '')
        truncated = truncated or len(rows) > selected['limit']
        bounded, size = [], 0
        for row in reversed(rows[-selected['limit']:]):
            size += len(json.dumps(row).encode())
            if size > 512 * 1024:
                truncated = True
                break
            bounded.append(row)
        return {'available': True, 'rows': list(reversed(bounded)), 'components': components, 'unavailable': unavailable, 'truncated': truncated, 'filters': selected, 'capturedAt': datetime.now(timezone.utc).isoformat()}

    def sample(self, component, container):
        logger = container.attrs.get('HostConfig', {}).get('LogConfig') or {}
        options = logger.get('Config') or {}
        result = {'component': component, 'state': container.status,
                  'retention': {'driver': logger.get('Type') or None, 'maxSize': options.get('max-size'), 'maxFiles': options.get('max-file')}}
        if container.status != 'running':
            return {**result, 'available': False, 'reason': 'Service is not running.'}
        try:
            return {**result, 'available': True, **metrics(container.stats(stream=False))}
        except Exception:
            return {**result, 'available': False, 'reason': 'Docker did not provide a statistics sample.'}


def register_routes(app, operator):
    telemetry = Telemetry(operator)
    async def logs(request):
        selected = filters(request.query)
        return web.json_response(await asyncio.to_thread(telemetry.read_logs, selected), headers={'Cache-Control': 'no-store'})
    async def performance(request):
        if request.query:
            raise ValueError('Performance does not accept container identifiers or commands.')
        containers = await asyncio.to_thread(telemetry.inventory)
        samples = await asyncio.gather(*(asyncio.to_thread(telemetry.sample, name, container) for name, container in sorted(containers.items())))
        queue = operator.db.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]
        return web.json_response({'available': True, 'components': samples, 'operationQueueDepth': queue, 'capturedAt': datetime.now(timezone.utc).isoformat()}, headers={'Cache-Control': 'no-store'})
    app.router.add_get('/logs', logs)
    app.router.add_get('/performance', performance)
