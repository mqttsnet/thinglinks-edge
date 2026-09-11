import type { EdgeCommandRecord } from '../../api/types.ts';
interface CommandLabel { label: string; type: 'default' | 'info' | 'success' | 'warning' | 'error'; hint: string }
export function commandStatus(status: EdgeCommandRecord['status']): CommandLabel {
  switch (status) {
    case 'queued': return { label: '等待执行', type: 'default', hint: '尚未交给设备执行器' };
    case 'leased': return { label: '执行中', type: 'info', hint: '已交给设备执行器，等待结果' };
    case 'succeeded': return { label: '设备执行成功', type: 'success', hint: '执行器已报告成功' };
    case 'failed': return { label: '设备执行失败', type: 'error', hint: '执行器已报告失败' };
    case 'rejected': return { label: '已拒绝执行', type: 'warning', hint: '未满足执行条件' };
    case 'unknown': return { label: '结果未知', type: 'warning', hint: '执行等待超时，可能已经写入设备；请先核对设备，系统不会自动重复执行。' };
  }
}
export function commandReplyStatus(command: EdgeCommandRecord): CommandLabel {
  if (command.status === 'queued' || command.status === 'leased') return { label: '等待执行结果', type: 'default', hint: '' };
  if (command.replyPending) return command.replyError
    ? { label: '回执待重试', type: 'warning', hint: command.replyError }
    : { label: '回执待发送', type: 'default', hint: '等待发布执行结果' };
  return { label: '回执已发布', type: 'info', hint: '已获 MQTT 发布确认；云端命令记录的关联与处理仍未确认。' };
}
