import { filterWorkspaceGroup, matchesProjectQuery, normalizeProjectQuery, pathBasename, shouldShowProjectSearch } from './project-search';

describe('project search', () => {
  const group = (name: string, projectPath: string, sessions: string[]) => ({
    workspace: { name, projectPath },
    sessions: sessions.map((s) => ({ name: s })),
  });

  it('appears with 2+ folders or 7+ projects', () => {
    expect(shouldShowProjectSearch(1, 6)).toBeFalse();
    expect(shouldShowProjectSearch(2, 0)).toBeTrue();
    expect(shouldShowProjectSearch(0, 7)).toBeTrue();
  });

  it('normalizes the query and ignores case', () => {
    expect(normalizeProjectQuery('  ApI ')).toBe('api');
    expect(matchesProjectQuery('api', 'My-API', null)).toBeTrue();
  });

  it('takes the last path segment on POSIX and Windows', () => {
    expect(pathBasename('/Users/me/projects/shop/')).toBe('shop');
    expect(pathBasename('C:\\code\\shop')).toBe('shop');
    expect(pathBasename(null)).toBe('');
  });

  it('keeps the whole workspace when its name or folder matches', () => {
    const g = group('Shop', '/code/storefront', ['a', 'b']);
    expect(filterWorkspaceGroup(g, 'shop')).toBe(g);
    expect(filterWorkspaceGroup(g, 'storefront')).toBe(g);
  });

  it('does not match parent folders of the path', () => {
    expect(filterWorkspaceGroup(group('Shop', '/code/shop', ['a']), 'code')).toBeNull();
  });

  it('narrows to the matching sessions otherwise', () => {
    const r = filterWorkspaceGroup(group('Shop', '/code/shop', ['login fix', 'cart']), 'cart');
    expect(r?.sessions.map((s) => s.name)).toEqual(['cart']);
  });
});
