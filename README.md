# ui-watercolor-reveal

🎨 WebGL practice - Recreate the watercolor reveal effect from https://ai-quest.lusion.co/ using Three.js and GLSL shaders.

https://github.com/user-attachments/assets/8c654b3c-527a-43bb-9c84-3ff559a06319

## Requirements

1. **Images:** Use the 3 webp files in the img folder (`1A_Story_Intro.webp`, `1B_Story_Intro.webp`, `1C_Story_Intro.webp`)

2. **Initial State:** Display images in black and white (grayscale)

3. **Interaction:**
- NO clicking or dragging required - just hover/mouse movement
- As the mouse moves over the image, reveal the colored version
- Track which pixels the mouse has touched

4. **Watercolor Effect:**

- Colors should "bleed" naturally around touched areas (not too much)
- Wavy, organic watercolor feel as colors are revealed
- The effect should imitate real watercolor spreading on paper

5. **Persistence:** Revealed colors should stay permanently (not fade back to B&W)

## Project Structure

```
ui-watercolor-reveal/
├── index.html          # Main HTML file
├── main.js             # Three.js scene setup and animation loop
├── style.css           # Styling
├── img/                # Webp files
├── shaders/
│   ├── vertex.js       # Vertex shader
│   └── fragment.js     # Fragment shader (watercolor magic happens here)
├── package.json
└── README.md
```

## References

- [Three.js Documentation](https://threejs.org/docs/)
- [The Book of Shaders](https://thebookofshaders.com/)
- [WebGL Fundamentals](https://webglfundamentals.org/)
- [Lusion Labs AI Quest](https://ai-quest.lusion.co/)
