#!/usr/bin/env bash
# Site validation script for Command Central landing page
# Checks for data consistency, broken links, and missing assets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SITE_DIR="$PROJECT_ROOT/site"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() {
    echo -e "${RED}❌ $1${NC}" >&2
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Track validation status
ERRORS=0
WARNINGS=0

check_test_count() {
    echo "Checking test count synchronization..."
    
    # Get current test count from bun test
    cd "$PROJECT_ROOT"
    ACTUAL_TESTS=$(bun test 2>&1 | grep -E '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' | head -1)
    
    if [ -z "$ACTUAL_TESTS" ]; then
        error "Could not determine actual test count"
        ((ERRORS++))
        return 1
    fi
    
    # Get test count from HTML
    HTML_TESTS=$(grep -oE '<span class="trust-number">[0-9]+</span>' "$SITE_DIR/index.html" | grep -oE '[0-9]+')
    
    if [ -z "$HTML_TESTS" ]; then
        error "Could not find test count in HTML"
        ((ERRORS++))
        return 1
    fi
    
    if [ "$ACTUAL_TESTS" != "$HTML_TESTS" ]; then
        error "Test count mismatch: HTML shows $HTML_TESTS but actual is $ACTUAL_TESTS"
        ((ERRORS++))
        return 1
    fi
    
    success "Test count synchronized: $ACTUAL_TESTS tests"
}

check_broken_links() {
    echo "Checking for broken links..."
    
    # Check internal links (href and src attributes)
    BROKEN_COUNT=0
    
    # Extract all href and src attributes from HTML files
    find "$SITE_DIR" -name "*.html" -exec grep -hoE '(href|src)="[^"]*"' {} \; | \
    sed 's/.*="\([^"]*\)"/\1/' | \
    grep -E '^(\./|/|[^h])' | \
    sort -u | while IFS= read -r link; do
        # Skip external URLs, mailto, tel, and data URLs
        if [[ "$link" =~ ^(https?|mailto|tel|data): ]]; then
            continue
        fi
        
        # Convert relative links to file paths
        if [[ "$link" =~ ^/ ]]; then
            # Absolute path from site root
            FILE_PATH="$SITE_DIR$link"
        else
            # Relative path from site directory
            FILE_PATH="$SITE_DIR/$link"
        fi
        
        # Remove query strings and fragments
        FILE_PATH="${FILE_PATH%%\?*}"
        FILE_PATH="${FILE_PATH%%\#*}"
        
        # Check if file exists
        if [ ! -f "$FILE_PATH" ] && [ ! -d "$FILE_PATH" ]; then
            error "Broken link: $link -> $FILE_PATH"
            BROKEN_COUNT=$((BROKEN_COUNT + 1))
        fi
    done
    
    if [ $BROKEN_COUNT -eq 0 ]; then
        success "No broken internal links found"
    else
        ((ERRORS++))
    fi
}

check_svgs_exist() {
    echo "Checking SVG assets..."
    
    # Check for SVG references in HTML and CSS
    SVG_MISSING=0
    
    # Find SVG references in HTML
    find "$SITE_DIR" -name "*.html" -exec grep -hoE 'src="[^"]*\.svg"' {} \; | \
    sed 's/src="\([^"]*\)"/\1/' | while IFS= read -r svg; do
        SVG_PATH="$SITE_DIR/$svg"
        if [ ! -f "$SVG_PATH" ]; then
            error "Missing SVG: $svg"
            SVG_MISSING=$((SVG_MISSING + 1))
        elif [ ! -s "$SVG_PATH" ]; then
            error "Empty SVG file: $svg"
            SVG_MISSING=$((SVG_MISSING + 1))
        fi
    done
    
    # Find SVG references in CSS
    find "$SITE_DIR" -name "*.css" -exec grep -hoE 'url\([^)]*\.svg[^)]*\)' {} \; | \
    sed 's/url(\([^)]*\))/\1/' | tr -d '"'"'" | while IFS= read -r svg; do
        SVG_PATH="$SITE_DIR/$svg"
        if [ ! -f "$SVG_PATH" ]; then
            error "Missing SVG referenced in CSS: $svg"
            SVG_MISSING=$((SVG_MISSING + 1))
        fi
    done
    
    if [ $SVG_MISSING -eq 0 ]; then
        success "All SVG assets found and non-empty"
    else
        ((ERRORS++))
    fi
}

check_og_image() {
    echo "Checking OG image..."
    
    # Extract OG image URL from HTML
    OG_IMAGE=$(grep -oE 'property="og:image" content="[^"]*"' "$SITE_DIR/index.html" | \
               sed 's/.*content="\([^"]*\)"/\1/')
    
    if [ -z "$OG_IMAGE" ]; then
        error "No og:image meta tag found"
        ((ERRORS++))
        return 1
    fi
    
    # Convert URL to file path
    if [[ "$OG_IMAGE" =~ ^https://partnerai\.dev/ ]]; then
        OG_PATH="${OG_IMAGE#https://partnerai.dev}"
        OG_FILE="$SITE_DIR$OG_PATH"
    else
        error "OG image URL format unexpected: $OG_IMAGE"
        ((ERRORS++))
        return 1
    fi
    
    if [ ! -f "$OG_FILE" ]; then
        error "OG image file not found: $OG_FILE"
        ((ERRORS++))
        return 1
    fi
    
    success "OG image exists: $OG_PATH"
}

check_placeholder_text() {
    echo "Checking for placeholder text..."
    
    # Look for common placeholder patterns
    PLACEHOLDER_PATTERNS=(
        "TODO"
        "FIXME"
        "Lorem ipsum"
        "test@example.com"
        "Your Name Here"
    )
    
    PLACEHOLDER_FOUND=0
    
    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
        if grep -riq "$pattern" "$SITE_DIR"/*.html "$SITE_DIR"/*.css 2>/dev/null; then
            warning "Possible placeholder text found: $pattern"
            ((WARNINGS++))
            PLACEHOLDER_FOUND=1
        fi
    done
    
    if [ $PLACEHOLDER_FOUND -eq 0 ]; then
        success "No placeholder text detected"
    fi
}

check_html_validation() {
    echo "Checking HTML structure..."
    
    # Basic HTML validation checks
    HTML_ERRORS=0
    
    # Check for required meta tags
    if ! grep -q '<meta name="description"' "$SITE_DIR/index.html"; then
        error "Missing meta description"
        HTML_ERRORS=$((HTML_ERRORS + 1))
    fi
    
    if ! grep -q '<title>' "$SITE_DIR/index.html"; then
        error "Missing title tag"
        HTML_ERRORS=$((HTML_ERRORS + 1))
    fi
    
    if ! grep -q 'property="og:' "$SITE_DIR/index.html"; then
        error "Missing Open Graph meta tags"
        HTML_ERRORS=$((HTML_ERRORS + 1))
    fi
    
    # Check for favicon
    if ! grep -q 'rel="icon"' "$SITE_DIR/index.html"; then
        warning "No favicon link found"
        ((WARNINGS++))
    fi
    
    if [ $HTML_ERRORS -eq 0 ]; then
        success "Basic HTML structure valid"
    else
        ((ERRORS++))
    fi
}

# Run all checks
echo "🔍 Starting site validation..."
echo

check_test_count
check_broken_links
check_svgs_exist
check_og_image
check_placeholder_text
check_html_validation

echo
echo "📊 Validation Summary:"
if [ $ERRORS -eq 0 ]; then
    success "All critical checks passed!"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}   $WARNINGS warnings${NC}"
    fi
    exit 0
else
    error "$ERRORS critical errors found"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}   $WARNINGS warnings${NC}"
    fi
    exit 1
fi