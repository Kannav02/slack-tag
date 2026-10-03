#!/bin/sh
# Blocks project containers (bridges named st-*) from the cloud metadata address and from the host itself.
# Other internet access stays open. Safe to run repeatedly; run after Docker starts (slack-tag-firewall.service).
set -eu
rule() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
iptables -N DOCKER-USER 2>/dev/null || true
rule DOCKER-USER -i st-+ -d 169.254.0.0/16 -j DROP
rule INPUT -i st-+ -j DROP
# Inserted after the drop so it sits above it: replies to the bridge's own connections (published ports) still arrive.
rule INPUT -i st-+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
