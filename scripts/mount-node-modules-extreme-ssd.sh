#!/bin/sh

set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mount_point="$project_root/node_modules"
disk_image="/Volumes/Extreme SSD/.node_modules/latent-node-modules.sparsebundle"

if mount | grep -Fq " on $mount_point "; then
	echo "node_modules is already mounted from Extreme SSD."
	exit 0
fi

if [ ! -e "$disk_image" ]; then
	echo "Extreme SSD is not mounted or the node_modules disk image is missing:" >&2
	echo "  $disk_image" >&2
	exit 1
fi

if [ -L "$mount_point" ]; then
	echo "Refusing to replace the node_modules symbolic link." >&2
	exit 1
fi

if [ -d "$mount_point" ] && [ -n "$(ls -A "$mount_point")" ]; then
	echo "Refusing to hide a non-empty local node_modules directory." >&2
	exit 1
fi

mkdir -p "$mount_point"
hdiutil attach "$disk_image" -mountpoint "$mount_point" -nobrowse
