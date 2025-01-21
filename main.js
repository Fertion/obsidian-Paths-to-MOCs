const { PluginSettingTab, Setting, Plugin, ItemView } = require('obsidian');

module.exports = class PathsToMOCsPlugin extends Plugin {
    headerPathElements = new Map(); // Store header elements keyed by leaf ID
    pathCache = new Map(); // Initialize path cache
    parentNotesCache = new Map(); // Cache for parent notes

    async onload() {
        this.settings = Object.assign({}, {
            propertyUp: "up",
            propertyDown: "down",
            mocTags: "MOC",
            headerName: "Subprojects",
            enablePropertyUp: true,
            enablePropertyDown: true,
            enableMocTags: true,
            enableHeaderName: true,
            excludedFolders: "",
            excludedTags: "",
            enableCaching: true,
            maxDepth: 15, // Default max depth
            displayPathsInHeader: true, // Setting to display paths in header
            pathSeparator: " → " // Setting for path separator
        }, await this.loadData());

        this.addSettingTab(new PathsToMOCsSettingTab(this.app, this));

        this.addCommand({
            id: "show-paths-side-window",
            name: "Show navigation paths in the side panel",
            callback: () => this.activateView(),
            icon: "list-tree"
        });

        this.addCommand({
            id: "refresh-paths",
            name: "Refresh paths",
            callback: async () => {
                this.pathCache.clear();
                this.parentNotesCache.clear();
                const currentFile = this.app.workspace.getActiveFile();
                if (currentFile && !this.isExcluded(currentFile.path)) {
                    await this.updateAllPathsAndHeaders(currentFile.path);
                } else {
                    this.updateSidebarPaths([]);
                    this.updateVisibleHeaders();
                }
            },
        });

        this.registerView(PathsToMOCsView.VIEW_TYPE, (leaf) => new PathsToMOCsView(leaf, this));

        this.app.workspace.on('active-leaf-change', async (leaf) => {
            if (leaf?.view?.file) {
                await this.updatePathsAndHeader(leaf);
            }
        });

        this.app.workspace.on('file-open', async (file) => {
            if (file) {
                await this.updateAllPathsAndHeaders(file.path);
            }
        });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(PathsToMOCsView.VIEW_TYPE);
        // Remove all header path elements
        this.headerPathElements.forEach((element) => {
            element.remove();
        });
        this.headerPathElements.clear();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const existingLeaf = this.app.workspace.getLeavesOfType(PathsToMOCsView.VIEW_TYPE)[0];

        if (!existingLeaf) {
            await this.app.workspace.getRightLeaf(false).setViewState({
                type: PathsToMOCsView.VIEW_TYPE,
                state: { active: true },
            });
        } else {
            this.app.workspace.revealLeaf(existingLeaf);
        }
    }

    isExcluded(filePath) {
        const excludedFolders = this.settings.excludedFolders.split(',').map(folder => folder.trim()).filter(Boolean);
        const excludedTags = this.settings.excludedTags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
        const file = this.app.vault.getAbstractFileByPath(filePath);

        if (!file) return false;

        // Check for excluded folders
        for (const folder of excludedFolders) {
            if (file.parent?.path.startsWith(folder)) {
                return true;
            }
        }

        // Check for excluded tags
        if (excludedTags.length > 0) {
            const metadata = this.app.metadataCache.getFileCache(file);
            const tags = new Set(
                (Array.isArray(metadata?.frontmatter?.tags) ? metadata.frontmatter.tags : [metadata?.frontmatter?.tags || ''])
                    .map(tag => tag?.toLowerCase().trim())
            );
            metadata?.tags?.forEach(tag => tags.add(tag.tag.substring(1).toLowerCase().trim()));
            for (const tag of excludedTags) {
                if (tags.has(tag)) {
                    return true;
                }
            }
        }

        return false;
    }

    async updateAllPathsAndHeaders(currentNotePath) {
        if (this.isExcluded(currentNotePath)) {
            this.updateSidebarPaths([]);
            this.updateVisibleHeadersForPath(currentNotePath, []);
            return;
        }
        const paths = await this.calculatePaths(currentNotePath);
        this.updateSidebarPaths(paths);
        this.updateVisibleHeadersForPath(currentNotePath, paths);
    }

    async updatePathsAndHeader(leaf) {
        if (!leaf?.view?.file) return;
        const currentNotePath = leaf.view.file.path;

        if (this.isExcluded(currentNotePath)) {
            this.removeHeaderPathElement(leaf);
            this.updateSidebarPaths([]);
            return;
        }

        const paths = await this.calculatePaths(currentNotePath);
        this.updateSidebarPaths(paths);
        this.displayHeaderPaths(leaf, paths);
    }

    updateSidebarPaths(paths) {
        this.app.workspace.getLeavesOfType(PathsToMOCsView.VIEW_TYPE).forEach(leaf => {
            const view = leaf.view;
            if (view instanceof PathsToMOCsView) {
                view.updatePaths(paths);
            }
        });
    }

    async calculatePaths(startNotePath) {
        if (this.isExcluded(startNotePath)) {
            return [];
        }

        if (this.settings.enableCaching && this.pathCache.has(startNotePath)) {
            return this.pathCache.get(startNotePath);
        }

        const paths = [];
        const queue = [[startNotePath, [startNotePath]]]; // [currentNotePath, currentPath]

        while (queue.length > 0) {
            const [currentNotePath, currentPath] = queue.shift();

            if (currentPath.length > this.settings.maxDepth) {
                continue; // Stop exploring this path if max depth is reached
            }

            const parentNotes = await this.getParentNotes(currentNotePath);
            for (const parentNote of parentNotes) {
                if (!currentPath.includes(parentNote)) {
                    queue.push([parentNote, [parentNote, ...currentPath]]);
                }
            }
            if (parentNotes.length === 0 && currentPath.length > 1) {
                paths.push(currentPath);
            }
        }

        const filteredPaths = this.filterSubPaths(paths.map(p => p.reverse()));
        const reversedFilteredPaths = filteredPaths.map(p => p.reverse());

        if (this.settings.enableCaching) {
            this.pathCache.set(startNotePath, reversedFilteredPaths);
        }

        return reversedFilteredPaths;
    }

     filterSubPaths(paths) {
        return paths.filter((path, index, self) => {
            return !self.some((otherPath, otherIndex) => {
                if (index === otherIndex) return false;
                if (otherPath.length < path.length) return false; // Only consider longer paths
                return otherPath.slice(-path.length).every((note, idx) => note === path[idx]);
            });
        });
    }

    async getParentNotes(notePath) {
        if (this.settings.enableCaching && this.parentNotesCache.has(notePath)) {
            return this.parentNotesCache.get(notePath);
        }

        const parentNotes = new Set();
        const file = this.app.vault.getAbstractFileByPath(notePath);

        if (!file || !(file instanceof this.app.vault.getFiles()[0].constructor)) {
            return [];
        }

        const resolveLink = (linkText, sourcePath) => {
            let dest = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
            if (!dest && !linkText.endsWith(".md")) {
                dest = this.app.metadataCache.getFirstLinkpathDest(linkText + ".md", sourcePath);
            }
            return dest?.path;
        };

        // Helper function to check if a link exists in the "Up" properties of a given file
        const isLinkedAsUp = (linkedFile, targetNotePath) => {
            const upProperties = this.settings.propertyUp.split(',').map(p => p.trim());
            const metadata = this.app.metadataCache.getFileCache(linkedFile);
            for (const propertyUp of upProperties) {
                if (metadata?.frontmatter?.[propertyUp]) {
                    const upLinks = Array.isArray(metadata.frontmatter[propertyUp])
                        ? metadata.frontmatter[propertyUp]
                        : [metadata.frontmatter[propertyUp]];
                    for (const link of upLinks) {
                        try {
                            const linkWithoutAlias = link.replace(/\|.*$/, '');
                            const linkedFilePath = resolveLink(linkWithoutAlias.replace("[[", "").replace("]]", ""), linkedFile.path);
                            if (linkedFilePath === targetNotePath) {
                                return true;
                            }
                        } catch (error) {
                            console.error("Error processing link in 'Up' property:", link, error);
                        }
                    }
                }
            }
            return false;
        };

        // Check for parent notes via "Up" property
        if (this.settings.enablePropertyUp) {
            const upProperties = this.settings.propertyUp.split(',').map(p => p.trim());
            const metadata = this.app.metadataCache.getFileCache(file);
            for (const propertyUp of upProperties) {
                if (metadata?.frontmatter?.[propertyUp]) {
                    const links = Array.isArray(metadata.frontmatter[propertyUp])
                        ? metadata.frontmatter[propertyUp]
                        : [metadata.frontmatter[propertyUp]];

                    for (const link of links) {
                        try {
                            const linkWithoutAlias = link.replace(/\|.*$/, '');
                            const linkedFilePath = resolveLink(linkWithoutAlias.replace("[[", "").replace("]]", ""), notePath);
                            if (linkedFilePath && !this.isExcluded(linkedFilePath)) {
                                parentNotes.add(linkedFilePath);
                            }
                        } catch (error) {
                            console.error("Error processing link in 'Up' property:", link, error);
                        }
                    }
                }
            }
        }

        // Check for parent notes linking to this note with "Down" property
        if (this.settings.enablePropertyDown) {
            const downProperties = this.settings.propertyDown.split(',').map(p => p.trim());
            const backlinks = this.app.metadataCache.getBacklinksForFile(file);
            if (backlinks) {
                for (const linkedFilePath of backlinks.keys()) {
                    if (this.isExcluded(linkedFilePath)) continue;
                    const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
                    const metadata = this.app.metadataCache.getFileCache(linkedFile);
                    for (const propertyDown of downProperties) {
                        if (metadata?.frontmatter?.[propertyDown]) {
                            const downLinks = Array.isArray(metadata.frontmatter[propertyDown])
                                ? metadata.frontmatter[propertyDown]
                                : [metadata.frontmatter[propertyDown]];

                            if (downLinks.some(link => {
                                try {
                                    const linkWithoutAlias = link.replace(/\|.*$/, '');
                                    return resolveLink(linkWithoutAlias.replace("[[", "").replace("]]", ""), linkedFilePath) === notePath;
                                } catch (error) {
                                    console.error("Error resolving link:", link, error);
                                    return false;
                                }
                            })) {
                                parentNotes.add(linkedFilePath);
                            }
                        }
                    }
                }
            }
        }

        // Check for parent notes linking to this note with MOC tags
        if (this.settings.enableMocTags) {
            const mocTagsArray = this.settings.mocTags.split(',').map(tag => tag.trim().toLowerCase());
            const backlinks = this.app.metadataCache.getBacklinksForFile(file);

            if (backlinks) {
                for (const linkedFilePath of backlinks.keys()) {
                    if (this.isExcluded(linkedFilePath)) continue;
                    const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
                    const metadata = this.app.metadataCache.getFileCache(linkedFile);
                    const tags = new Set(
                        (Array.isArray(metadata?.frontmatter?.tags) ? metadata.frontmatter.tags : [metadata?.frontmatter?.tags || ''])
                            .map(tag => tag?.toLowerCase().trim())
                    );

                    const fileCache = this.app.metadataCache.getFileCache(linkedFile);
                    fileCache?.tags?.forEach(tag => tags.add(tag.tag.substring(1).toLowerCase().trim()));

                    for (const tag of mocTagsArray) {
                        if (tags.has(tag)) {
                            // Check if the link to the current note comes from an "Up" property of the MOC note
                            if (!isLinkedAsUp(linkedFile, notePath)) {
                                parentNotes.add(linkedFilePath);
                            }
                            break;
                        }
                    }
                }
            }
        }

        // Check for parent notes linking to this note under a specific header
        if (this.settings.enableHeaderName) {
            const headerNames = this.settings.headerName.split(',').map(h => h.trim());
            const backlinks = this.app.metadataCache.getBacklinksForFile(file);
            if (backlinks) {
                for (const linkedFilePath of backlinks.keys()) {
                    if (this.isExcluded(linkedFilePath)) continue;
                    const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
                    const headingCache = this.app.metadataCache.getCache(linkedFilePath)?.headings || [];
                    const resolvedLinks = this.app.metadataCache.getCache(linkedFilePath)?.links || [];

                    for (const link of Object.values(resolvedLinks)) {
                        const targetBasename = file.basename;
                        const targetName = file.name;
                        if (link.link === targetBasename || link.link === targetName) {
                            const linkPos = link.position.start.line;
                            for (const headerName of headerNames) {
                                for (const heading of headingCache) {
                                    if (heading.level <= 6 && heading.heading === headerName) {
                                        if (linkPos > heading.position.start.line &&
                                            (!headingCache[headingCache.indexOf(heading) + 1] ||
                                             linkPos < headingCache[headingCache.indexOf(heading) + 1].position.start.line)) {
                                            parentNotes.add(linkedFilePath);
                                            break;
                                        }
                                    }
                                }
                                if (parentNotes.has(linkedFilePath)) break;
                            }
                        }
                        if (parentNotes.has(linkedFilePath)) break;
                    }
                }
            }
        }

        const parentNotesArray = Array.from(parentNotes);
        if (this.settings.enableCaching) {
            this.parentNotesCache.set(notePath, parentNotesArray);
        }
        return parentNotesArray;
    }

    async displayHeaderPaths(leaf, paths) {
        if (!this.settings.displayPathsInHeader) {
            this.removeHeaderPathElement(leaf);
            return;
        }

        const currentNotePath = leaf.view.file?.path;
        if (!currentNotePath) {
            this.removeHeaderPathElement(leaf);
            return;
        }

        if (this.isExcluded(currentNotePath)) {
            this.removeHeaderPathElement(leaf);
            return;
        }

        const leafId = leaf.id;
        let headerContainer = this.headerPathElements.get(leafId);
        if (!headerContainer) {
            headerContainer = createDiv({ cls: 'paths-to-mocs-header-container' });
            this.headerPathElements.set(leafId, headerContainer);

            const titleEl = leaf.containerEl.querySelector('.inline-title') || leaf.containerEl.querySelector('.view-header');
            if (titleEl && titleEl.parentNode) {
                titleEl.parentNode.insertBefore(headerContainer, titleEl);
            } else {
                console.error("displayHeaderPaths: Не удалось найти элемент заголовка для leaf ID:", leafId);
                this.headerPathElements.delete(leafId); // Clean up if insertion fails
                return;
            }
        }

        headerContainer.empty();

        if (paths.length === 0) {
            headerContainer.setText("No paths to MOCs found.");
            return;
        }

        paths.forEach(async (path, pathIndex) => { // Added async here
            const pathWrapper = headerContainer.createDiv({ cls: 'path-wrapper' });

            for (const [idx, notePath] of path.entries()) { // Changed forEach to for...of for async
                const note = this.app.vault.getAbstractFileByPath(notePath)?.basename || notePath;

                if (idx > 0) pathWrapper.appendText(this.settings.pathSeparator);

                const link = pathWrapper.createEl("a", {
                    text: note,
                    cls: 'paths-to-mocs-header-link',
                });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(notePath, '', e.ctrlKey);
                });
            }

            if (pathIndex < paths.length - 1) {
                headerContainer.createDiv({ cls: 'path-divider' });
            }
        });
    }

    removeHeaderPathElement(leaf) {
        const leafId = leaf.id;
        if (this.headerPathElements.has(leafId)) {
            const headerContainer = this.headerPathElements.get(leafId);
            headerContainer.remove();
            this.headerPathElements.delete(leafId);
        }
    }

    // Update headers for all visible leaves that display the given file path
    async updateVisibleHeadersForPath(filePath, paths) {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (leaf.view.file && leaf.view.file.path === filePath) {
                this.displayHeaderPaths(leaf, paths);
            }
        }
    }

    // Update headers for all visible leaves
    async updateVisibleHeaders() {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (leaf.view.file) {
                await this.updatePathsAndHeader(leaf);
            } else {
                this.removeHeaderPathElement(leaf);
            }
        }
    }
}

class PathsToMOCsSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl("h2", { text: "Paths to MOCs Settings" });

        containerEl.createEl("h3", { text: "Paths Display" });

        new Setting(containerEl)
            .setName("Display paths in the header")
            .setDesc("If enabled, the paths will be displayed at the top of the active note.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.displayPathsInHeader)
                .onChange(async (value) => {
                    this.plugin.settings.displayPathsInHeader = value;
                    await this.plugin.saveSettings();
                    await this.plugin.updateVisibleHeaders();
                })
            );

        new Setting(containerEl)
            .setName("Path Separator")
            .setDesc("The separator between notes in the path display.")
            .addText(text => {
                text
                    .setPlaceholder(" → ")
                    .setValue(this.plugin.settings.pathSeparator)
                    .onChange(async (value) => {
                        this.plugin.settings.pathSeparator = value;
                        await this.plugin.saveSettings();
                        await this.plugin.updateVisibleHeaders();
                    });
            });

        containerEl.createEl("h3", { text: "Paths Calculation" });

        new Setting(containerEl)
            .setName("Enable caching")
            .setDesc("Enable caching to improve performance by storing calculated paths. Disable if you want paths to update dynamically on every tab change. Use the 'Refresh paths' command to manually update the cache.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCaching)
                .onChange(async (value) => {
                    this.plugin.settings.enableCaching = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(containerEl)
            .setName("Limit Search Depth")
            .setDesc("Maximum number of notes in a path. Longer paths will be truncated.")
            .addText(text => {
                text
                    .setPlaceholder("15")
                    .setValue(String(this.plugin.settings.maxDepth))
                    .onChange(async (value) => {
                        const parsedValue = parseInt(value);
                        if (!isNaN(parsedValue) && parsedValue > 0) {
                            this.plugin.settings.maxDepth = parsedValue;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        containerEl.createEl("h3", { text: "How to Determine Hierarchical Links" });

        new Setting(containerEl)
            .setName("Find Parent Notes via YAML Properties")
            .setDesc("Notes linked in the specified property of the current note will be treated as parent notes. Use comma to separate multiple properties.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enablePropertyUp)
                .onChange(async (value) => {
                    this.plugin.settings.enablePropertyUp = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addText(text => {
                text
                    .setPlaceholder("Property name for parent links")
                    .setValue(this.plugin.settings.propertyUp)
                    .setDisabled(!this.plugin.settings.enablePropertyUp)
                    .onChange(async (value) => {
                        this.plugin.settings.propertyUp = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Find Parent Notes via Backlinks in YAML Properties")
            .setDesc("Notes that link to the current note via their specified property will be treated as parent notes. Use comma to separate multiple properties.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enablePropertyDown)
                .onChange(async (value) => {
                    this.plugin.settings.enablePropertyDown = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addText(text => {
                text
                    .setPlaceholder("Property name for child links")
                    .setValue(this.plugin.settings.propertyDown)
                    .setDisabled(!this.plugin.settings.enablePropertyDown)
                    .onChange(async (value) => {
                        this.plugin.settings.propertyDown = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Find Parent Notes via MOC Tags")
            .setDesc("Notes linking to the current note that have the specified MOC tags will be treated as parent notes. Use comma to separate multiple tags.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMocTags)
                .onChange(async (value) => {
                    this.plugin.settings.enableMocTags = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addText(text => {
                text
                    .setPlaceholder("Tags for MOC notes (comma-separated)")
                    .setValue(this.plugin.settings.mocTags)
                    .setDisabled(!this.plugin.settings.enableMocTags)
                    .onChange(async (value) => {
                        this.plugin.settings.mocTags = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Find Parent Notes via Specific Headers")
            .setDesc("Notes linking to the current note under the specified section header will be treated as parent notes. Use comma to separate multiple headers.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableHeaderName)
                .onChange(async (value) => {
                    this.plugin.settings.enableHeaderName = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addText(text => {
                text
                    .setPlaceholder("Header name")
                    .setValue(this.plugin.settings.headerName)
                    .setDisabled(!this.plugin.settings.enableHeaderName)
                    .onChange(async (value) => {
                        this.plugin.settings.headerName = value;
                        await this.plugin.saveSettings();
                    });
            });

        containerEl.createEl("h3", { text: "Filtering" });

        new Setting(containerEl)
            .setName("Exclude Notes in These Folders")
            .setDesc("Specify folders to exclude from the paths. Use comma to separate multiple folders.")
            .addTextArea(text => {
                text
                    .setPlaceholder("Examples: Folder1, Folder2/Subfolder")
                    .setValue(this.plugin.settings.excludedFolders)
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Exclude Notes with These Tags")
            .setDesc("Specify tags to exclude from the paths. Notes containing these tags will not be considered. Use comma to separate multiple tags.")
            .addTextArea(text => {
                text
                    .setPlaceholder("Examples: tag1, tag2")
                    .setValue(this.plugin.settings.excludedTags)
                    .onChange(async (value) => {
                        this.plugin.settings.excludedTags = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}

class PathsToMOCsView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.contentEl.style.overflow = 'auto'; // Enable scroll for the view content
    }

    static VIEW_TYPE = "paths-to-mocs-view";

    getViewType() {
        return PathsToMOCsView.VIEW_TYPE;
    }

    getDisplayText() {
        return "Paths to MOCs";
    }

    getIcon() {
        return "list-tree";
    }

    async onOpen() {
        this.container = this.contentEl; // Use contentEl for adding scroll
        this.container.empty();
        // Initial message
        const initialContainer = this.container.createDiv({ cls: 'paths-to-mocs-header-container' });
        initialContainer.setText("Paths to MOCs will be displayed here.");

        const currentFile = this.app.workspace.getActiveFile();
        if (currentFile && !this.plugin.isExcluded(currentFile.path)) {
            await this.updatePaths(await this.plugin.calculatePaths(currentFile.path));
        } else if (currentFile) {
            this.updatePaths([]);
        }
    }

    async updatePaths(paths = []) {
        const container = this.container;
        container.empty();

        const currentFile = this.app.workspace.getActiveFile();
        if (currentFile && this.plugin.isExcluded(currentFile.path)) {
            return; // Do not display "No paths found" if the current file is excluded
        }

        const pathsContainer = container.createDiv({ cls: 'paths-to-mocs-header-container' });

        if (paths.length === 0) {
            pathsContainer.setText("No paths to MOCs found for the current note.");
            return;
        }

        const viewContent = pathsContainer.createDiv({ cls: 'paths-to-mocs-view-content' });

        for (const [pathIndex, path] of paths.entries()) {
            const pathWrapper = viewContent.createDiv({ cls: 'path-wrapper' });
            for (const [idx, notePath] of path.entries()) {
                const note = this.app.vault.getAbstractFileByPath(notePath)?.basename || notePath;
                if (idx > 0) pathWrapper.appendText(this.plugin.settings.pathSeparator);
                const link = pathWrapper.createEl("a", {
                    text: note,
                    cls: 'paths-to-mocs-header-link'
                });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.plugin.app.workspace.openLinkText(notePath, '', e.ctrlKey);
                });
            }
            if (pathIndex < paths.length - 1) {
                viewContent.createDiv({ cls: 'path-divider' });
            }
        }
    }

    async onClose() {
        // Cleanup if necessary
    }
}