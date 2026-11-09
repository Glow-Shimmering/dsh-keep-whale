import type { Credentials } from '../../src/credentials.js';
export function memoryCredentials(): Credentials & { values: Map<string,string> } {
  const values=new Map<string,string>();
  return {values,async resolve(ref){const value=values.get(ref);return value===undefined?undefined:{value,source:'file'};},async set(ref,value){if(!value)throw new Error('empty');values.set(ref,value);},async unset(ref){values.delete(ref);}};
}
