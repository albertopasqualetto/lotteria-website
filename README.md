# Lotteria - Lottery Drawing

A simple web-based lottery drawing with an animated drum, prizes and exclusions.

This code is mostly AI generated.

## Features

- 🎱 **Animated Drum** - The drum spins, the balls bounce around and one rolls out down the tube
- 🎁 **Reveal** - The extracted ball grows full screen and opens to show the number
- 🔢 **Any Range** - Choose the range of numbers to draw from (up to 100000 numbers)
- 🚫 **Exclusions** - Exclude numbers at setup or during the drawing (e.g. unsold tickets)
- 🏆 **Prizes** - Optional ordered prizes, assigned to the extracted numbers in order
- 📜 **Extraction History** - View all extracted numbers in reverse chronological order
- 🎊 **Confetti Animation** - Celebrate when the last prize is drawn
- 💾 **Auto-Save** - Drawing state is automatically saved to localStorage
- 🔗 **Shareable Links** - Share drawing state via URL parameters
- 🎨 **Customizable Colors** - Use URL parameter to change the accent color

## Getting Started

Simply open `index.html` in a web browser. No build process or dependencies required!

## How to Use

### Setting Up
- Enter the range of numbers ("Da" / "A")
- Optionally enter the numbers to exclude, as a list of numbers and intervals (e.g. `13, 27, 40-45`)
- Click "Inizia"

### Extracting Numbers
- Click "Estrai" or press Space to draw a random number among the remaining ones
- Click the extracted ball, or press Space or Escape, to close the reveal
- Click a number in the history to put it back into the drum

### Managing Prizes
- Add prizes using the input field in the sidebar (click + or press Enter)
- Drag prizes to reorder them, delete them with the × button
- Prizes already assigned to an extracted number can't be moved or deleted
- Without prizes, the history shows the extracted numbers only

### Excluding Numbers
- Add exclusions using the input field at the bottom of the sidebar (click + or press Enter)
- Put excluded numbers back into the drum with the × button

### Resetting the Drawing
- Click the "Reset" button to clear range, extracted numbers, prizes and exclusions

### Customizing Colors
Add a `color` parameter to the URL with a hex color code (without #):
```
index.html?color=2e86de
```

### Sharing Drawing State
The drawing state is automatically encoded in the URL, so you can share your current drawing by copying the URL from your browser's address bar.

## Technical Details

- **Pure JavaScript** - No frameworks or libraries required
- **Canvas Animation** - Drum and balls are drawn on a canvas with a simple physics simulation
- **Fair Drawing** - Numbers are drawn with `crypto.getRandomValues`, without modulo bias
- **Responsive Design** - Works on desktop and mobile devices
- **Reduced Motion** - Shorter animations and no confetti when the system asks for reduced motion
- **LocalStorage** - Drawing state persists across browser sessions
- **URL State Management** - Share drawing state via URL parameters

## File Structure

```
├── index.html    # Main HTML structure
├── style.css     # Styling and animations
└── app.js        # Drawing logic, drum animation and state management
```

## Browser Compatibility

Works in all modern browsers that support:
- ES6 JavaScript
- Canvas 2D
- CSS `color-mix()`
- LocalStorage API
