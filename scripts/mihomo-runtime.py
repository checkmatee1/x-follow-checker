#!/usr/bin/env python3
"""Supervise a private mihomo snapshot; never print configuration or core logs."""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import yaml


def main():
    runtime = None
    child = None
    def stop(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        options = json.loads(sys.stdin.buffer.readline())
        runtime = Path(options['directory'])
        source = Path(options['source'])
        config = yaml.safe_load(source.read_text())
        providers = {}
        for index, provider in enumerate(config.get('proxy-providers', {}).values()):
            filename = Path(provider.get('path', ''))
            if not filename.is_absolute():
                filename = source.parent / filename
            if not filename.is_file():
                continue
            target = runtime / f'provider-{index}.yaml'
            shutil.copyfile(filename, target)
            target.chmod(0o600)
            providers[f'provider-{index}'] = {'type': 'file', 'path': str(target)}
        proxies = [p for p in config.get('proxies', []) if isinstance(p, dict) and p.get('type', '').lower() not in ('direct', 'reject', 'reject-drop', 'pass')]
        if not proxies and not providers:
            raise ValueError('no cached nodes')
        # Only local snapshots: no provider URLs, health checks, TUN, DNS hijack,
        # subscription refresh, system rules, external UI or source controller.
        private = {
            'mixed-port': options['port'], 'bind-address': '127.0.0.1',
            'allow-lan': False, 'mode': 'rule', 'log-level': 'silent',
            'external-controller': f"127.0.0.1:{options['controllerPort']}",
            'secret': options['secret'], 'ipv6': False,
            'tun': {'enable': False}, 'dns': {'enable': False},
            'profile': {'store-selected': False, 'store-fake-ip': False},
            'proxies': proxies, 'proxy-providers': providers,
            'proxy-groups': [{'name': 'XFC', 'type': 'select',
                              'proxies': [p['name'] for p in proxies],
                              'use': list(providers)}],
            'rules': ['MATCH,XFC'],
        }
        target = runtime / 'config.yaml'
        target.write_text(json.dumps(private))
        target.chmod(0o600)
        child = subprocess.Popen([options['binary'], '-d', str(runtime), '-f', str(target)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        print(json.dumps({'started': True, 'providerCount': len(providers)}), flush=True)
        while child.poll() is None:
            readable, _, _ = select.select([sys.stdin.buffer], [], [], 0.25)
            if readable and not os.read(sys.stdin.fileno(), 1):
                break
        return 0
    except (SystemExit, KeyboardInterrupt):
        return 0
    except Exception:
        # Parse errors can include credential-bearing YAML snippets. Suppress them.
        print(json.dumps({'started': False}), flush=True)
        return 1
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if runtime is not None:
            shutil.rmtree(runtime, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
