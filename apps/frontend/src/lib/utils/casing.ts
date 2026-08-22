import { isLetter } from './is-letter.js';

export function camelToSnake(str: string): string {
  let newStr = '';

  for (let i = 0; i < str.length; i++) {
    if (isLetter(str[i]) && str[i].toUpperCase() === str[i]) {
      let l = i;

      while (l < str.length && isLetter(str[l]) && str[l].toUpperCase() === str[l]) {
        l++;
      }

      newStr += `${str.slice(i, l - 1).toLocaleLowerCase()}_${str[l - 1].toLocaleLowerCase()}`;

      i = l - 1;

      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function pascalToSnake(str: string): string {
  let newStr = '';

  let firstLetter: number | undefined;

  for (let i = 0; i < str.length; i++) {
    if (firstLetter === undefined && isLetter(str[i])) {
      firstLetter = i;
    }

    if (
      firstLetter !== undefined &&
      i > firstLetter &&
      isLetter(str[i]) &&
      str[i].toUpperCase() === str[i]
    ) {
      let l = i;

      while (l < str.length && isLetter(str[l]) && str[l].toUpperCase() === str[l]) {
        l++;
      }

      newStr += `${str.slice(i, l - 1).toLocaleLowerCase()}_${str[l - 1].toLocaleLowerCase()}`;

      i = l - 1;

      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function camelToKebab(str: string): string {
  let newStr = '';

  for (let i = 0; i < str.length; i++) {
    if (i > 0 && isLetter(str[i]) && str[i].toUpperCase() === str[i]) {
      let l = i;

      while (l < str.length && isLetter(str[l]) && str[l].toUpperCase() === str[l]) {
        l++;
      }

      newStr += `${str.slice(i, l - 1).toLocaleLowerCase()}-${str[l - 1].toLocaleLowerCase()}`;

      i = l - 1;

      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function pascalToKebab(str: string): string {
  let newStr = '';

  for (let i = 0; i < str.length; i++) {
    if (i > 0 && isLetter(str[i]) && str[i].toUpperCase() === str[i]) {
      let l = i;

      while (l < str.length && isLetter(str[l]) && str[l].toUpperCase() === str[l]) {
        l++;
      }

      newStr += `${str.slice(i, l - 1).toLocaleLowerCase()}-${str[l - 1].toLocaleLowerCase()}`;

      i = l - 1;

      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function camelToPascal(str: string): string {
  return `${str[0].toLocaleUpperCase()}${str.slice(1)}`;
}

export function pascalToCamel(str: string): string {
  return `${str[0].toLocaleLowerCase()}${str.slice(1)}`;
}

export function snakeToPascal(str: string): string {
  let newStr = '';

  let firstLetter = true;

  for (let i = 0; i < str.length; i++) {
    if (firstLetter && isLetter(str[i])) {
      firstLetter = false;
      newStr += str[i].toUpperCase();
      continue;
    }

    if (!firstLetter && str[i] === '_') {
      i++;
      if (i <= str.length - 1) {
        newStr += str[i].toUpperCase();
      } else {
        newStr += '_';
      }
      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function snakeToCamel(str: string): string {
  let newStr = '';

  let firstLetter = true;

  for (let i = 0; i < str.length; i++) {
    if (firstLetter && isLetter(str[i])) {
      firstLetter = false;
      newStr += str[i].toLowerCase();
      continue;
    }

    if (!firstLetter && str[i] === '_') {
      i++;
      if (i <= str.length - 1) {
        newStr += str[i].toUpperCase();
      } else {
        newStr += '_';
      }
      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function kebabToPascal(str: string): string {
  let newStr = '';

  for (let i = 0; i < str.length; i++) {
    if (i === 0) {
      newStr += str[i].toUpperCase();
      continue;
    }

    if (str[i] === '-') {
      i++;
      if (i <= str.length - 1) {
        newStr += str[i].toUpperCase();
      }
      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}

export function kebabToCamel(str: string): string {
  let newStr = '';

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '-') {
      i++;
      if (i <= str.length - 1) {
        newStr += str[i].toUpperCase();
      }
      continue;
    }

    newStr += str[i].toLocaleLowerCase();
  }

  return newStr;
}
