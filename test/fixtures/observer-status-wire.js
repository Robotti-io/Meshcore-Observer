export function deviceInfoFrame({ firmware = 'v1.18.0', repeat = true } = {}) {
  const frame = Buffer.alloc(82); frame[0] = 13; frame[1] = 14;
  frame.writeUInt32LE(0x11223344, 4); // Synthetic PIN: never part of normalized output.
  frame.write('15-Oct-2026', 8); frame.write('Heltec V3', 20); frame.write(firmware, 60);
  frame[80] = Number(repeat); return [...frame];
}
export function coreStatsFrame({ battery = 4123, uptime = 98765 } = {}) {
  const frame = Buffer.alloc(11); frame[0] = 24; frame[1] = 0;
  frame.writeUInt16LE(battery, 2); frame.writeUInt32LE(uptime, 4);
  frame.writeUInt16LE(0x1234, 8); frame[10] = 3; return [...frame];
}
export function radioStatsFrame({ noise = -118 } = {}) {
  const frame = Buffer.alloc(14); frame[0] = 24; frame[1] = 1;
  frame.writeInt16LE(noise, 2); frame.writeInt8(-75, 4); frame.writeInt8(12, 5);
  frame.writeUInt32LE(10, 6); frame.writeUInt32LE(20, 10); return [...frame];
}
export function observerStatusReply(command) {
  if (command[0] === 22) return deviceInfoFrame();
  if (command[0] === 56 && command[1] === 0) return coreStatsFrame();
  if (command[0] === 56 && command[1] === 1) return radioStatsFrame();
  return null;
}
