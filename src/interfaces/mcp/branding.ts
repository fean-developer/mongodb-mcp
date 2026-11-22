import { readFileSync } from 'node:fs';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

export const serverVersion = '2.0.0';

type Icon = NonNullable<Implementation['icons']>[number];

// Ícones em data: URI: o VS Code só aceita data: ou file: em servidores stdio, e file: falha em WSL/remoto.
// O caminho é o mesmo a partir de src/ (tsx) e de dist/ (pacote instalado).
export function loadIcons(directory = new URL('../../../assets/', import.meta.url)): Icon[] {
  const icons: Icon[] = [];
  for (const size of [64, 128]) {
    try {
      const data = readFileSync(new URL(`icon-${size}.png`, directory)).toString('base64');
      icons.push({ src: `data:image/png;base64,${data}`, mimeType: 'image/png', sizes: [`${size}x${size}`] });
    } catch {
      // Sem ícone o servidor continua funcional; o cliente mostra o ícone genérico.
    }
  }
  return icons;
}

const icons = loadIcons();

// Nas tools basta o tamanho menor (o VS Code pede ~22 px); evita repetir o PNG de 128 px seis vezes.
export const toolIcons: Icon[] = icons.filter((icon) => icon.sizes?.includes('64x64'));

export function serverInfo(): Implementation {
  return {
    name: 'mongodb-readonly-mcp',
    title: 'MongoDB Read-Only MCP',
    version: serverVersion,
    description: 'Consultas somente leitura ao MongoDB com políticas de bancos, coleções e campos.',
    ...(icons.length > 0 ? { icons } : {}),
  };
}
