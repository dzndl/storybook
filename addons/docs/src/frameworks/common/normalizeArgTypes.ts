import mapValues from 'lodash/mapValues';
import { ArgTypes } from '@storybook/csf';

const normalizeType = (type: ArgTypes[any]['type'] | string) =>
  typeof type === 'string' ? { name: type } : type;

const normalizeControl = (control?: any) =>
  typeof control === 'string' ? { type: control } : control;

export const normalizeArgTypes = (argTypes: ArgTypes) =>
  mapValues(argTypes, (argType) => {
    if (!argType) return argType;
    const normalized = { ...argType };
    const { type, control } = argType;
    if (type) normalized.type = normalizeType(type);
    if (control) normalized.control = normalizeControl(control);
    return normalized;
  });
