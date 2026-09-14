import { modbusRecipe } from '../../flows/templates/builtin/modbus.ts';
import { validateParameters } from '../../flows/templates/parameters.ts';
import { host } from '../../flows/templates/builtin/common.ts';
import { DiagnosticError, type ModbusDiagnosticConnection } from './types.ts';
const keys = ['host', 'port', 'unitId', 'registerType', 'address', 'quantity', 'clientTimeout', 'reconnectTimeout'];
const fields = modbusRecipe.parameters.filter(field => keys.includes(field.key));
export function validateConnection(input: unknown): ModbusDiagnosticConnection {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)))
      throw new Error();
    const values = validateParameters(fields, input);
    for (const key of keys.filter(key => key !== 'host' && key !== 'registerType'))
      if (!Number.isSafeInteger(values[key]))
        throw new Error();
    values.host = host(values.host);
    if ((values.address as number) + (values.quantity as number) > 65536)
      throw new Error();
    return values as unknown as ModbusDiagnosticConnection;
  }
  catch {
    throw new DiagnosticError('INVALID_CONNECTION', '试读参数无效，请检查设备地址、端口、站号及寄存器范围。');
  }
}
