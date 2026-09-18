import { BlockList, isIP } from 'node:net';

const privateNetworkAddresses = new BlockList();

// IPv4 loopback + RFC 1918 私网
privateNetworkAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
privateNetworkAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
privateNetworkAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
privateNetworkAddresses.addSubnet('192.168.0.0', 16, 'ipv4');

// IPv6 loopback + Unique private Address
privateNetworkAddresses.addAddress('::1', 'ipv6');
privateNetworkAddresses.addSubnet('fc00::', 7, 'ipv6');

export function isPrivateNetworkHost(hostname: string): boolean {
	const normalized = hostname.startsWith('[') && hostname.endsWith(']')
		? hostname.slice(1, -1)
		: hostname;

	if (normalized.toLowerCase() === 'privatehost' || normalized.toLowerCase() === 'localhost' || normalized.toLowerCase().endsWith('.localhost')) {
		return true;
	}

	const family = isIP(normalized);
	if (family === 4) {
		return privateNetworkAddresses.check(normalized, 'ipv4');
	}
	if (family === 6) {
		return privateNetworkAddresses.check(normalized, 'ipv6');
	}

	return false;
}
